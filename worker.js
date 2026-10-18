const db = require('./db');
const ms = require('./ms');
const g = require('./google');
const { sleep } = require('./http');

const MB = 1024 * 1024, GB = 1024 * MB;
const CONC = Number(process.env.CONCURRENCY || 4);
const MAX_RETRIES = 4;
const running = new Map(); // jobId -> { paused }

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

function decide(job, f) {
  const isImg = f.mime.startsWith('image/'), isVid = f.mime.startsWith('video/');
  const okPhotos = (isImg && f.size <= 200 * MB) || (isVid && f.size <= 10 * GB);
  if (job.dest === 'drive') return 'drive';
  if (job.dest === 'gcs') return 'gcs';
  if (job.dest === 'photos') return okPhotos ? 'photos' : null;
  return okPhotos ? 'photos' : 'drive'; // auto
}

async function scan(job, ctl) {
  if (job.scanned) return;
  const insert = db.prepare(
    'insert or ignore into files(job_id,item_id,dir,name,size,mime) values(?,?,?,?,?,?)');
  const queue = [{ id: job.folder_id, dir: job.folder_name }];
  while (queue.length && !ctl.paused) {
    const { id, dir } = queue.shift();
    for (const it of await ms.children(id)) {
      if (it.folder) queue.push({ id: it.id, dir: dir + '/' + it.name });
      else if (it.file) insert.run(job.id, it.id, dir, it.name, it.size || 0, mimeOf(it));
    }
  }
  if (!ctl.paused) db.prepare('update jobs set scanned=1 where id=?').run(job.id);
}

async function transfer(job, f) {
  const kind = decide(job, f);
  if (!kind) {
    db.prepare("update files set status='skipped', error=? where id=?").run('Not a supported photo/video for Google Photos', f.id);
    return;
  }
  const rd = ms.reader(f.item_id);
  let destId;
  if (kind === 'drive') {
    const parent = await g.driveFolder(f.dir);
    destId = (await g.driveUpload({ name: f.name, parent, size: f.size, mime: f.mime }, rd)).id;
  } else if (kind === 'gcs') {
    const r = await g.gcsUpload({ bucket: job.bucket, object: `${f.dir}/${f.name}`, size: f.size, mime: f.mime }, rd);
    destId = r.name;
  } else {
    const albumId = await g.photosAlbum(f.dir);
    destId = await g.photosUpload({ name: f.name, size: f.size, mime: f.mime, albumId }, await rd.stream());
  }
  db.prepare("update files set status='done', dest_kind=?, dest_id=?, error=null where id=?").run(kind, destId, f.id);
}

async function lane(job, ctl) {
  const next = db.prepare("select * from files where job_id=? and status='pending' limit 1");
  while (!ctl.paused) {
    const f = next.get(job.id);
    if (!f) return;
    db.prepare("update files set status='active' where id=?").run(f.id);
    try {
      await transfer(job, f);
    } catch (e) {
      const retries = f.retries + 1;
      const status = retries >= MAX_RETRIES ? 'failed' : 'pending';
      db.prepare('update files set status=?, retries=?, error=? where id=?').run(status, retries, String(e.message).slice(0, 500), f.id);
      console.error(`[job ${job.id}] ${f.dir}/${f.name}: ${e.message}`);
      await sleep(Math.min(5000 * retries, 30000));
    }
  }
}

async function start(jobId) {
  if (running.has(jobId)) return;
  const ctl = { paused: false };
  running.set(jobId, ctl);
  try {
    let job = db.prepare('select * from jobs where id=?').get(jobId);
    db.prepare("update jobs set status='scanning', error=null where id=?").run(jobId);
    await scan(job, ctl);
    if (ctl.paused) return;
    db.prepare("update jobs set status='running' where id=?").run(jobId);
    job = db.prepare('select * from jobs where id=?').get(jobId);
    await Promise.all(Array.from({ length: CONC }, () => lane(job, ctl)));
    if (ctl.paused) return;
    const failed = db.prepare("select count(*) c from files where job_id=? and status='failed'").get(jobId).c;
    db.prepare('update jobs set status=? where id=?').run(failed ? 'done_with_errors' : 'done', jobId);
  } catch (e) {
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

function resumeAll() {
  db.prepare("update files set status='pending' where status='active'").run();
  for (const j of db.prepare("select id from jobs where status in ('scanning','running')").all()) start(j.id);
}

module.exports = { start, pause, retryFailed, resumeAll };
