const { http } = require('./http');
const { auth } = require('./google');

// Reading from Google, for Google -> OneDrive transfers.

// ---------- Google Drive ----------
const DRIVE = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
// Google Docs, Sheets, Slides and Drawings have no file to download; they are exported instead.
const EXPORTS = {
  'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  'application/vnd.google-apps.drawing': ['image/png', '.png'],
};

async function driveList(id) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({
      q: `'${id.replace(/'/g, "\\'")}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,size)', pageSize: '1000', orderBy: 'folder,name',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await http(`${DRIVE}/files?${q}`, { headers: await auth() });
    if (!r.ok) throw new Error(`Drive list ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...j.files);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out.map((f) => ({ id: f.id, name: f.name, mime: f.mimeType, size: Number(f.size) || 0, isFolder: f.mimeType === FOLDER }));
}

// Name and mime type the file gets in OneDrive, or null when Google can't export it (Forms, Sites, shortcuts...).
function driveTarget(file) {
  if (!file.mime.startsWith('application/vnd.google-apps.')) return { name: file.name, mime: file.mime };
  const exp = EXPORTS[file.mime];
  return exp ? { name: file.name + exp[1], mime: exp[0] } : null;
}

async function driveDownload(id, mime) {
  const exp = EXPORTS[mime];
  const url = exp ? `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(exp[0])}` : `${DRIVE}/files/${id}?alt=media`;
  const r = await http(url, { headers: await auth() });
  if (!r.ok) throw new Error(`Drive download ${r.status}: ${await r.text()}`);
  return r.body;
}

// ---------- Google Photos picker ----------
// Apps can no longer list a whole Photos library; the user picks items in Google's picker instead.
const PICKER = 'https://photospicker.googleapis.com/v1';

async function pickerCall(method, u) {
  const r = await http(PICKER + u, { method, headers: await auth() });
  if (!r.ok) {
    const text = await r.text();
    let message = text;
    try { message = JSON.parse(text).error?.message || text; } catch {}
    throw new Error(`Photos picker ${r.status}: ${message}`);
  }
  return method === 'DELETE' ? null : r.json();
}

const pickerCreate = () => pickerCall('POST', '/sessions');
const pickerGet = (id) => pickerCall('GET', `/sessions/${encodeURIComponent(id)}`);

async function pickerItems(sessionId) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ sessionId, pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await pickerCall('GET', `/mediaItems?${q}`);
    out.push(...(j.mediaItems || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

// Download links expire after 60 minutes, so they are re-read from the session when stale.
const links = new Map(); // sessionId -> { at, byId }
async function pickerLink(sessionId, itemId) {
  let cached = links.get(sessionId);
  if (!cached || Date.now() - cached.at > 50 * 60 * 1000) {
    let items;
    try {
      items = await pickerItems(sessionId);
    } catch (e) {
      throw new Error(`The Google Photos selection is no longer available (${e.message}). Make a new selection.`);
    }
    cached = { at: Date.now(), byId: new Map(items.map((i) => [i.id, i.mediaFile])) };
    links.set(sessionId, cached);
  }
  const file = cached.byId.get(itemId);
  if (!file) throw new Error('This item is no longer in the Google Photos selection');
  return file;
}

async function pickerDownload(sessionId, itemId) {
  const file = await pickerLink(sessionId, itemId);
  // =d downloads the original photo, =dv the original video.
  const suffix = file.mimeType?.startsWith('video/') ? '=dv' : '=d';
  const r = await http(file.baseUrl + suffix, { headers: await auth() });
  if (!r.ok) {
    if (r.status === 403 || r.status === 404) links.delete(sessionId);
    throw new Error(`Photos download ${r.status}: ${await r.text()}`);
  }
  return r.body;
}

module.exports = { driveList, driveTarget, driveDownload, pickerCreate, pickerGet, pickerItems, pickerDownload };
