const tokens = require('./tokens');
const db = require('./db');
const { http, sleep } = require('./http');

const P = 'google';
const CHUNK = 16 * 1024 * 1024; // multiple of 256 KiB, required by resumable protocols
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/devstorage.read_write',
].join(' ');
const redirect = () => `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`;
let refreshing = null;

function authUrl(state) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error('Google OAuth is not configured. Add GOOGLE_CLIENT_ID to .env and restart the server.');
  }
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirect(), response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent', state,
  });
}

async function tokenReq(params) {
  const r = await http('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || 'Google token error');
  const prev = tokens.load(P) || {};
  tokens.save(P, {
    access_token: j.access_token,
    refresh_token: j.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (j.expires_in - 120) * 1000,
  });
}

const exchange = (code) => tokenReq({ grant_type: 'authorization_code', code, redirect_uri: redirect() });

async function token() {
  const t = tokens.load(P);
  if (!t) throw new Error('Google not connected');
  if (Date.now() < t.expires_at) return t.access_token;
  if (!refreshing) {
    refreshing = tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
  return tokens.load(P).access_token;
}

const connected = () => !!tokens.load(P);
const auth = async () => ({ Authorization: 'Bearer ' + (await token()) });

// Generic resumable upload: used by Drive and Cloud Storage. src.range(start,end) supplies bytes.
async function resumable(initUrl, initHeaders, initBody, size, src) {
  const init = await http(initUrl, {
    method: 'POST',
    headers: { ...(await auth()), ...initHeaders, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size) },
    body: JSON.stringify(initBody),
  });
  if (!init.ok) throw new Error(`Upload init ${init.status}: ${await init.text()}`);
  const session = init.headers.get('location');
  if (size === 0) {
    const r = await http(session, { method: 'PUT', headers: { 'Content-Length': '0' }, body: '' });
    if (!r.ok) throw new Error(`Empty upload ${r.status}: ${await r.text()}`);
    return r.json();
  }
  let off = 0;
  while (off < size) {
    const end = Math.min(off + CHUNK, size) - 1;
    const buf = await src.range(off, end);
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(session, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${off}-${end}/${size}`, 'Content-Length': String(buf.length) },
          body: buf,
        });
      } catch (e) {
        if (attempt >= 5) throw e;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (r.status === 308) break;
      if (r.ok) return r.json();
      if ((r.status === 429 || r.status >= 500) && attempt < 5) { await sleep(2 ** attempt * 1000); continue; }
      throw new Error(`Chunk upload ${r.status}: ${await r.text()}`);
    }
    off = end + 1;
  }
  throw new Error('Upload finished without final response');
}

// Memoised "create once" helper so parallel workers never create duplicate folders/albums.
const memo = new Map();
function ensure(kind, key, create) {
  const k = kind + '|' + key;
  if (memo.has(k)) return memo.get(k);
  const p = (async () => {
    const row = db.prepare('select value from maps where kind=? and key=?').get(kind, key);
    if (row) return row.value;
    const v = await create();
    db.prepare('insert or replace into maps(kind,key,value) values(?,?,?)').run(kind, key, v);
    return v;
  })();
  memo.set(k, p);
  p.catch(() => memo.delete(k));
  return p;
}

// ---------- Drive ----------
async function driveFolder(dirPath) {
  let parent = 'root';
  let acc = '';
  for (const seg of dirPath.split('/').filter(Boolean)) {
    acc += '/' + seg;
    const p = parent;
    parent = await ensure('drive', acc, async () => {
      const r = await http('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { ...(await auth()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: seg, mimeType: 'application/vnd.google-apps.folder', parents: [p] }),
      });
      if (!r.ok) throw new Error(`Drive folder ${r.status}: ${await r.text()}`);
      return (await r.json()).id;
    });
  }
  return parent;
}

async function driveUpload({ name, parent, size, mime }, src) {
  const r = await resumable(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum',
    { 'X-Upload-Content-Type': mime || 'application/octet-stream' },
    { name, parents: [parent] }, size, src);
  return r;
}

// ---------- Cloud Storage ----------
async function gcsUpload({ bucket, object, size, mime }, src) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&name=${encodeURIComponent(object)}`;
  return resumable(url, { 'X-Upload-Content-Type': mime || 'application/octet-stream' },
    { contentType: mime || 'application/octet-stream' }, size, src);
}

// ---------- Photos ----------
let photosLock = Promise.resolve();
const serial = (fn) => { const p = photosLock.then(fn, fn); photosLock = p.catch(() => {}); return p; };

async function photosAlbum(dirPath) {
  const title = dirPath.split('/').filter(Boolean).join(' - ').slice(0, 500) || 'OneDrive Transfer';
  return ensure('album', dirPath, async () => {
    const r = await http('https://photoslibrary.googleapis.com/v1/albums', {
      method: 'POST',
      headers: { ...(await auth()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ album: { title } }),
    });
    if (!r.ok) throw new Error(`Album create ${r.status}: ${await r.text()}`);
    return (await r.json()).id;
  });
}

async function photosUpload({ name, size, mime, albumId }, bodyStream) {
  const up = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
    method: 'POST',
    headers: {
      ...(await auth()), 'Content-Type': 'application/octet-stream',
      'Content-Length': String(size), 'X-Goog-Upload-Content-Type': mime,
      'X-Goog-Upload-Protocol': 'raw', 'X-Goog-Upload-File-Name': encodeURIComponent(name),
    },
    body: bodyStream, duplex: 'half',
  });
  if (!up.ok) throw new Error(`Photos upload ${up.status}: ${await up.text()}`);
  const uploadToken = await up.text();
  return serial(async () => {
    const r = await http('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'POST',
      headers: { ...(await auth()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId, newMediaItems: [{ simpleMediaItem: { fileName: name, uploadToken } }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Photos create ${r.status}: ${JSON.stringify(j)}`);
    const res = j.newMediaItemResults?.[0];
    if (res?.status?.code && res.status.code !== 0) throw new Error('Photos rejected: ' + res.status.message);
    return res?.mediaItem?.id || 'ok';
  });
}

module.exports = { authUrl, exchange, connected, driveFolder, driveUpload, gcsUpload, photosAlbum, photosUpload, CHUNK };
