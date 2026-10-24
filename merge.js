const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const CHUNK = 16 * 1024 * 1024;

function mediaKey(name) {
  return String(name || '').toLowerCase();
}

function sidecarNames(mediaName) {
  const name = String(mediaName || '');
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const duplicate = stem.match(/^(.*)\((\d+)\)$/);
  const names = new Set([
    `${name}.json`,
    `${name}.supplemental-metadata.json`,
    `${name}.supplemental-metadat.json`,
  ].map(mediaKey));
  if (duplicate) {
    const original = duplicate[1];
    const number = duplicate[2];
    for (const suffix of ['.json', '.supplemental-metadata.json', '.supplemental-metadat.json']) {
      names.add(mediaKey(`${original}${ext}(${number})${suffix}`));
    }
  }
  return names;
}

function isSidecar(name) {
  return /\.json$/i.test(String(name || '')) &&
    (/\.supplemental-metadat(?:a)?\.json$/i.test(name) || /\.[^.]+\.json$/i.test(name));
}

function findSidecar(media, sidecars) {
  const names = sidecarNames(media.name);
  return sidecars.find((sidecar) => names.has(mediaKey(sidecar.name))) || null;
}

function findMediaForSidecar(sidecar, mediaFiles) {
  return mediaFiles.find((media) => findSidecar(media, [sidecar])) || null;
}

async function streamToFile(stream, target) {
  const out = fs.createWriteStream(target);
  try {
    for await (const chunk of stream) {
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { out.once('close', resolve); out.once('error', reject); out.end(); });
  } catch (e) {
    out.destroy();
    throw e;
  }
}

async function download(reader, size, target) {
  const handle = await fsp.open(target, 'w');
  try {
    for (let offset = 0; offset < size; offset += CHUNK) {
      const end = Math.min(size - 1, offset + CHUNK - 1);
      const data = await reader.range(offset, end);
      await handle.write(data, 0, data.length, offset);
    }
  } finally {
    await handle.close();
  }
}

function takeoutDate(metadata) {
  const timestamp = Number(metadata.photoTakenTime?.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const offset = Number(process.env.TZ_OFFSET_MINUTES || 0);
  const date = new Date(timestamp * 1000 + (Number.isFinite(offset) ? offset : 0) * 60000);
  const iso = date.toISOString().replace('T', ' ').replace(/\.000Z$/, '');
  return iso;
}

function gpsArgs(metadata) {
  const lat = Number(metadata.geoData?.latitude);
  const lon = Number(metadata.geoData?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return [];
  return [`-GPSLatitude=${lat}`, `-GPSLongitude=${lon}`, `-GPSLatitudeRef=${lat < 0 ? 'S' : 'N'}`, `-GPSLongitudeRef=${lon < 0 ? 'W' : 'E'}`];
}

async function mergeFile(media, sidecar, ms) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'onedrive-merge-'));
  const target = path.join(dir, media.name);
  let keep = false;
  try {
    await download(ms.reader(media.item_id), Number(media.size) || 0, target);
    const metadata = JSON.parse(await (async () => {
      const chunks = [];
      for await (const chunk of (await ms.reader(sidecar.item_id).stream())) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    })());
    const date = takeoutDate(metadata);
    const args = ['-overwrite_original'];
    if (date) args.push(`-DateTimeOriginal=${date}`, `-CreateDate=${date}`, `-ModifyDate=${date}`, `-QuickTime:CreateDate=${date}`, `-QuickTime:ModifyDate=${date}`);
    args.push(...gpsArgs(metadata), target);
    if (args.length === 2) { keep = true; return { path: target, size: Number(media.size) || 0, changed: false }; }
    try {
      await execFileAsync(process.env.EXIFTOOL_PATH || 'exiftool', args, { windowsHide: true });
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('ExifTool is not installed or EXIFTOOL_PATH is invalid');
      console.warn(`[merge] ExifTool failed for ${media.name}; uploading original: ${e.message}`);
      keep = true;
      return { path: target, size: Number(media.size) || 0, changed: false };
    }
    const stat = await fsp.stat(target);
    keep = true;
    return { path: target, size: stat.size, changed: true };
  } catch (e) {
    if (e.code === 'ENOENT' && !String(e.message).includes('ExifTool')) throw e;
    throw e;
  } finally {
    if (!keep) await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function removeTemp(filePath) {
  if (!filePath) return;
  await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
}

module.exports = { CHUNK, isSidecar, sidecarNames, findSidecar, findMediaForSidecar, mergeFile, removeTemp, streamToFile };
