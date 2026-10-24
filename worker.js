const db = require('./db');
const ms = require('./ms');
const g = require('./google');
const gs = require('./gsource');
const takeout = require('./takeout');
const { sleep } = require('./http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const merge = require('./merge');
const settings = require('./settings');
const meter = require('./meter');

const MB = 1024 * 1024, GB = 1024 * MB;
const MAX_RETRIES = 4;
const AUTH_PAUSE = 'Sign-in needed: ';
const running = new Map(); // jobId -> { paused, lanes, job, done, error }

const EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', webm: 'video/webm', '3gp': 'video/3gpp', mpg: 'video/mpeg',
};
function mimeOf(item) {
  const m = item.file?.mimeType;
  if (m && m !== 'application/octet-stream') return m;
  const ext = item.name.split('.').pop().toLowerCase();
  return EXT[ext] || m || 'application/octet-stream';
}
const isMedia = (f) => f.mime.startsWith('image/') || f.mime.startsWith('video/');

function decide(job, f) {
  const isImg = f.mime.startsWith('image/'), isVid = f.mime.startsWith('video/');
  const okPhotos = (isImg && f.size <= 200 * MB) || (isVid && f.size <= 10 * GB);
  if (job.dest === 'drive') return 'drive';
  if (job.dest === 'gcs') return 'gcs';
  if (job.dest === 'photos') return okPhotos ? 'photos' : (job.fallback ? 'drive' : null);
  return okPhotos ? 'photos' : 'drive'; // auto
}

// A finished copy of the same, unchanged source file to the same destination.
// Photos picker items have no size until downloaded, so size 0 matches any size.
function alreadyCopied(job, f, kind) {
  if (!job.skip_existing) return null;
  return db.prepare(`select f.job_id from files f join jobs j on j.id = f.job_id
    where f.item_id = ? and (? = 0 or f.size = ?) and f.status = 'done' and f.dest_kind = ? and f.job_id <> ?
      and (f.dest_kind = 'gcs' and j.bucket = ? or f.dest_kind = 'onedrive' and j.target_id = ?
        or f.dest_kind not in ('gcs', 'onedrive')) limit 1`)
    .get(f.item_id, f.size, f.size, kind, job.id, job.bucket, job.target_id);
}

// Photos refuses some files that look like media (unsupported formats, corrupt files).
const photosRefused = (e) => /^Photos (rejected|upload 400)/.test(e.message);

// Lists a folder of the job's source as { id, name, size, mime, isFolder }.
function lister(job) {
  if (job.source === 'gdrive') return gs.driveList;
  return async (id) => (await ms.children(id)).filter((it) => it.folder || it.file).map((it) => ({
    id: it.id, name: it.name, size: it.size || 0, isFolder: !!it.folder, mime: it.file ? mimeOf(it) : null,
  }));
}

async function scan(job, ctl) {
  if (job.scanned) return;
  const insert = db.prepare(
    'insert or ignore into files(job_id,item_id,dir,name,size,mime) values(?,?,?,?,?,?)');
  if (job.source === 'gphotos') {
    for (const it of await gs.pickerItems(job.folder_id)) {
      insert.run(job.id, it.id, job.folder_name, it.mediaFile.filename, 0, it.mediaFile.mimeType || mimeOf({ name: it.mediaFile.filename }));
    }
  } else if (job.source === 'takeout') {
    for await (const f of takeout.files(job.folder_id)) {
      if (ctl.paused) return;
      insert.run(job.id, f.rel, f.dir ? `${job.folder_name}/${f.dir}` : job.folder_name, f.name, f.size, mimeOf({ name: f.name }));
    }
  } else {
    const list = lister(job);
    const queue = [{ id: job.folder_id, dir: job.folder_name }];
    while (queue.length && !ctl.paused) {
      const { id, dir } = queue.shift();
      for (const it of await list(id)) {
        if (it.isFolder) queue.push({ id: it.id, dir: dir + '/' + it.name });
        else insert.run(job.id, it.id, dir, it.name, it.size, it.mime);
      }
    }
  }
  if (!ctl.paused) db.prepare('update jobs set scanned=1 where id=?').run(job.id);
}

// With metadata merge on, a Takeout .json sidecar is folded into its photo/video instead of being copied.
function sidecarMerged(job, f) {
  if (!job.merge || !merge.isSidecar(f.name)) return false;
  const mediaFiles = db.prepare("select * from files where job_id=? and dir=? and id<>? and status in ('pending','active','done') and (mime like 'image/%' or mime like 'video/%')").all(job.id, f.dir, f.id);
  if (!merge.findMediaForSidecar(f, mediaFiles)) return false;
  db.prepare("update files set status='done', dest_kind='merged', error=? where id=?").run('Metadata merged into its photo/video', f.id);
  return true;
}

// Writes the Takeout date and location into a copy of the photo/video. Returns { path, size } or null.
async function mergeMetadata(job, f, source) {
  if (!job.merge || !isMedia(f)) return null;
  const sidecars = db.prepare("select * from files where job_id=? and dir=? and status in ('pending','active','done')").all(job.id, f.dir);
  const sidecar = merge.findSidecar(f, sidecars);
  if (!sidecar) return null;
  try {
    const fixed = await merge.mergeFile(f, sidecar, source);
    db.prepare("update files set status='done', dest_kind='merged', error=? where id=?").run('Metadata merged into its photo/video', sidecar.id);
    return fixed;
  } catch (e) {
    if (String(e.message).includes('ExifTool is not installed')) throw e;
    console.warn(`[job ${job.id}] metadata merge failed for ${f.name}; uploading original: ${e.message}`);
    return null;
  }
}

function markExisting(job, f, kind) {
  const prior = alreadyCopied(job, f, kind);
  if (prior) db.prepare("update files set status='existing', dest_kind=?, error=? where id=?").run(kind, `Already copied by job #${prior.job_id}`, f.id);
  return !!prior;
}

async function toGoogle(job, f) {
  if (sidecarMerged(job, f)) return;
  let kind = decide(job, f);
  if (!kind) {
    db.prepare("update files set status='skipped', error=? where id=?").run('Not a supported photo/video for Google Photos', f.id);
    return;
  }
  if (markExisting(job, f, kind)) return;
  let upload = { reader: ms.reader(f.item_id), size: f.size };
  const fixed = await mergeMetadata(job, f, ms);
  if (fixed) upload = { reader: takeout.fileReader(fixed.path), size: fixed.size };
  try {
    const rd = meter.metered(job.id, upload.reader);
    const toDrive = async () => {
      const parent = await g.driveFolder(f.dir);
      return (await g.driveUpload({ name: f.name, parent, size: upload.size, mime: f.mime }, rd)).id;
    };
    let destId;
    if (kind === 'drive') {
      destId = await toDrive();
    } else if (kind === 'gcs') {
      const r = await g.gcsUpload({ bucket: job.bucket, object: `${f.dir}/${f.name}`, size: upload.size, mime: f.mime }, rd);
      destId = r.name;
    } else {
      try {
        const albumId = await g.photosAlbum(f.dir);
        destId = await g.photosUpload({ name: f.name, size: upload.size, mime: f.mime, albumId }, await rd.stream());
      } catch (e) {
        if (!photosRefused(e) || !(job.fallback || job.dest === 'auto')) throw e;
        console.warn(`[job ${job.id}] Photos refused ${f.name}; sending it to Drive: ${e.message}`);
        kind = 'drive';
        destId = await toDrive();
      }
    }
    db.prepare("update files set status='done', dest_kind=?, dest_id=?, error=null where id=?").run(kind, destId, f.id);
  } finally {
    if (fixed) await merge.removeTemp(fixed.path);
  }
}

// Google files are saved to a temp file first: OneDrive needs the size up front,
// and Photos items don't report one.
async function downloadToTemp(job, f) {
  const body = job.source === 'gphotos'
    ? await gs.pickerDownload(job.folder_id, f.item_id)
    : await gs.driveDownload(f.item_id, f.mime);
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'cloudlift-')), 'download');
  await merge.streamToFile(body, file);
  return { path: file, size: (await fsp.stat(file)).size };
}

async function toOneDrive(job, f) {
  if (job.source === 'takeout' && sidecarMerged(job, f)) return;
  let name = f.name;
  if (job.source === 'gdrive') {
    const target = gs.driveTarget({ name: f.name, mime: f.mime });
    if (!target) {
      db.prepare("update files set status='skipped', error=? where id=?").run("Google can't export this kind of file (Forms, Sites, shortcuts…)", f.id);
      return;
    }
    name = target.name;
  }
  if (markExisting(job, f, 'onedrive')) return;
  const temps = [];
  try {
    let upload;
    if (job.source === 'takeout') {
      upload = { reader: takeout.reader(job.folder_id, f.item_id), size: f.size };
      const fixed = await mergeMetadata(job, f, { reader: (id) => takeout.reader(job.folder_id, id) });
      if (fixed) { temps.push(fixed.path); upload = { reader: takeout.fileReader(fixed.path), size: fixed.size }; }
    } else {
      const local = await downloadToTemp(job, f);
      temps.push(local.path);
      upload = { reader: takeout.fileReader(local.path), size: local.size };
    }
    const parentId = await ms.folderPath(job.target_id, f.dir);
    const destId = await ms.upload({ parentId, name, size: upload.size }, meter.metered(job.id, upload.reader));
    // Keep the source size for re-run matching; only Photos picker items (size 0) take the downloaded size.
    db.prepare("update files set status='done', dest_kind='onedrive', dest_id=?, size=case when size=0 then ? else size end, error=null where id=?").run(destId, upload.size, f.id);
  } finally {
    for (const t of temps) await merge.removeTemp(t);
  }
}

const transfer = (job, f) => (job.direction === 'to_onedrive' ? toOneDrive(job, f) : toGoogle(job, f));

function pauseForAuth(jobId, message) {
  const c = running.get(jobId);
  if (c) c.paused = true;
  db.prepare("update jobs set status='paused', error=? where id=?").run(AUTH_PAUSE + message, jobId);
}

async function lane(job, ctl) {
  const next = db.prepare("select * from files where job_id=? and status='pending' limit 1");
  try {
    // A lane stops when the job is paused or the concurrency setting is lowered.
    while (!ctl.paused && ctl.lanes <= settings.get().concurrency) {
      const f = next.get(job.id);
      if (!f) return;
      db.prepare("update files set status='active' where id=?").run(f.id);
      try {
        await transfer(job, f);
      } catch (e) {
        if (e.auth) {
          db.prepare("update files set status='pending' where id=?").run(f.id);
          pauseForAuth(job.id, e.message);
          return;
        }
        const retries = f.retries + 1;
        const status = retries >= MAX_RETRIES ? 'failed' : 'pending';
        db.prepare('update files set status=?, retries=?, error=? where id=?').run(status, retries, String(e.message).slice(0, 500), f.id);
        console.error(`[job ${job.id}] ${f.dir}/${f.name}: ${e.message}`);
        await sleep(Math.min(5000 * retries, 30000));
      }
    }
  } catch (e) {
    ctl.error = e;
  } finally {
    if (--ctl.lanes === 0) ctl.done();
  }
}

function spawnLanes(ctl) {
  const missing = settings.get().concurrency - ctl.lanes;
  for (let i = 0; i < missing; i++) {
    ctl.lanes++;
    lane(ctl.job, ctl);
  }
}

async function start(jobId) {
  if (running.has(jobId)) return;
  const ctl = { paused: false, lanes: 0, job: null };
  running.set(jobId, ctl);
  try {
    const job = db.prepare('select * from jobs where id=?').get(jobId);
    db.prepare("update jobs set status='scanning', error=null where id=?").run(jobId);
    await scan(job, ctl);
    if (ctl.paused) return;
    db.prepare("update jobs set status='running' where id=?").run(jobId);
    ctl.job = db.prepare('select * from jobs where id=?').get(jobId);
    await new Promise((resolve) => { ctl.done = resolve; spawnLanes(ctl); });
    if (ctl.error) throw ctl.error;
    if (ctl.paused) return;
    const failed = db.prepare("select count(*) c from files where job_id=? and status='failed'").get(jobId).c;
    db.prepare('update jobs set status=? where id=?').run(failed ? 'done_with_errors' : 'done', jobId);
  } catch (e) {
    if (e.auth) return pauseForAuth(jobId, e.message);
    console.error(e);
    db.prepare("update jobs set status='error', error=? where id=?").run(e.message, jobId);
  } finally {
    running.delete(jobId);
  }
}

function pause(jobId) {
  const c = running.get(jobId);
  if (c) c.paused = true;
  db.prepare("update jobs set status='paused' where id=?").run(jobId);
}

function retryFailed(jobId) {
  db.prepare("update files set status='pending', retries=0 where job_id=? and status='failed'").run(jobId);
  start(jobId);
}

// Re-queues files Google Photos could not take and sends them to Drive instead.
function skippedToDrive(jobId) {
  if (running.has(jobId)) throw new Error('Pause the job first');
  const job = db.prepare('select direction from jobs where id=?').get(jobId);
  if (job?.direction === 'to_onedrive') throw new Error('Only OneDrive → Google jobs can send skipped files to Drive');
  db.prepare('update jobs set fallback=1 where id=?').run(jobId);
  db.prepare("update files set status='pending', retries=0, error=null where job_id=? and status='skipped'").run(jobId);
  start(jobId);
}

// Applies a changed concurrency setting to jobs that are already transferring.
function applySettings() {
  for (const ctl of running.values()) if (ctl.job && !ctl.paused) spawnLanes(ctl);
}

function resumeAuthPaused() {
  for (const j of db.prepare("select id from jobs where status='paused' and error like ?").all(AUTH_PAUSE + '%')) start(j.id);
}

function resumeAll() {
  db.prepare("update files set status='pending' where status='active'").run();
  for (const j of db.prepare("select id from jobs where status in ('scanning','running')").all()) start(j.id);
}

const isRunning = (jobId) => running.has(jobId);
const anyRunning = () => running.size > 0;

module.exports = { start, pause, retryFailed, skippedToDrive, applySettings, resumeAuthPaused, resumeAll, isRunning, anyRunning };
