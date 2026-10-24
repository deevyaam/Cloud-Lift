require('dns').setDefaultResultOrder('ipv4first');
require('net').setDefaultAutoSelectFamilyAttemptTimeout(5000);
require('dotenv').config();
const express = require('express');
const archiver = require('archiver');
const { ZipArchive } = archiver;
const { Readable } = require('stream');
const crypto = require('crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const db = require('./db');
const ms = require('./ms');
const g = require('./google');
const worker = require('./worker');
const settings = require('./settings');
const meter = require('./meter');
const execFileAsync = promisify(execFile);
const { describeError } = require('./http');

const app = express();
app.use(express.json());
app.use(express.static('public'));
const states = new Set();

function oauthState() {
  const value = `${Date.now()}.${crypto.randomUUID()}`;
  const key = process.env.TOKEN_KEY || 'temporary-oauth-state-key';
  const signature = crypto.createHmac('sha256', key).update(value).digest('base64url');
  return `${Buffer.from(value).toString('base64url')}.${signature}`;
}

function validOAuthState(value) {
  if (typeof value !== 'string') return false;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return false;
  const raw = Buffer.from(encoded, 'base64url').toString();
  const timestamp = Number(raw.split('.')[0]);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > 10 * 60 * 1000) return false;
  const key = process.env.TOKEN_KEY || 'temporary-oauth-state-key';
  const expected = crypto.createHmac('sha256', key).update(raw).digest('base64url');
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function htmlText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function login(provider) {
  const label = provider.name === 'microsoft' ? 'Microsoft' : 'Google';
  app.get(`/auth/${provider.name}`, (req, res) => {
    const s = oauthState();
    states.add(s);
    try {
      res.redirect(provider.mod.authUrl(s));
    } catch (e) {
      states.delete(s);
      res.status(500).send(`
        <main style="font-family:system-ui;max-width:680px;margin:64px auto;padding:0 24px;color:#18212f">
          <h1>${label} connection is not configured</h1>
          <p>${htmlText(e.message)}</p>
          <p>Copy <code>.env.example</code> to <code>.env</code>, add your ${label} app values, then restart the website.</p>
          <a href="/">← Back to CloudLift</a>
        </main>`);
    }
  });
  app.get(`/auth/${provider.name}/callback`, async (req, res) => {
    if (!states.delete(req.query.state) && !validOAuthState(req.query.state)) return res.status(400).send('Invalid or expired OAuth state. Start the connection again from this server.');
    if (req.query.error) return res.status(400).send(`OAuth was not completed: ${req.query.error_description || req.query.error}`);
    if (!req.query.code) return res.status(400).send('OAuth callback did not include an authorization code');
    try {
      await provider.mod.exchange(req.query.code);
      worker.resumeAuthPaused();
      res.redirect('/');
    } catch (e) {
      const message = describeError(e);
      console.error(`[oauth:${provider.name}] ${message}`);
      res.status(502).send(`<main style="font-family:system-ui;max-width:680px;margin:64px auto;padding:0 24px;color:#18212f"><h1>${provider.name} connection failed</h1><p>${htmlText(message)}</p><p>Check the server network connection and try again.</p><a href="/">← Back to CloudLift</a></main>`);
    }
  });
}
login({ name: 'microsoft', mod: ms });
login({ name: 'google', mod: g });

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  const message = describeError(e);
  console.error(`[api ${req.method} ${req.originalUrl}] ${message}`);
  res.status(500).json({ error: message });
});

const providers = { microsoft: ms, google: g };

async function accountStatus(mod) {
  const connected = mod.connected();
  let account = null;
  if (connected && !mod.problem()) {
    try { account = await mod.account(); } catch (e) { console.warn(`[status] account lookup failed: ${describeError(e)}`); }
  }
  return { connected, account, problem: mod.problem() };
}

app.get('/api/status', wrap(async (req, res) => {
  const [microsoftAccount, googleAccount] = await Promise.all([accountStatus(ms), accountStatus(g)]);
  res.json({
    microsoft: microsoftAccount.connected,
    google: googleAccount.connected,
    microsoftAccount,
    googleAccount,
    microsoftConfigured: !!process.env.MS_CLIENT_ID && !!process.env.MS_CLIENT_SECRET,
    googleConfigured: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
  });
}));

app.post('/api/accounts/:provider/disconnect', wrap(async (req, res) => {
  const mod = providers[req.params.provider];
  if (!mod) return res.status(404).json({ error: 'Unknown account' });
  if (worker.anyRunning()) return res.status(409).json({ error: 'Pause running transfers before disconnecting an account.' });
  await mod.disconnect();
  res.json({ ok: true });
}));

app.get('/api/settings', (req, res) => res.json(settings.get()));

app.put('/api/settings', (req, res) => {
  try {
    const saved = settings.set(req.body || {});
    worker.applySettings();
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/exiftool', async (req, res) => {
  try {
    const result = await execFileAsync(process.env.EXIFTOOL_PATH || 'exiftool', ['-ver'], { windowsHide: true });
    res.json({ ok: true, version: result.stdout.trim() });
  } catch (e) {
    res.json({ ok: false, version: null, error: e.code === 'ENOENT' ? 'ExifTool not found' : e.message });
  }
});

app.get('/api/ms/children', wrap(async (req, res) => {
  const items = await ms.children(req.query.id || 'root');
  res.json(items.map((i) => ({ id: i.id, name: i.name, size: i.size, isFolder: !!i.folder })));
}));

app.post('/api/jobs', wrap(async (req, res) => {
  const { folderId, folderName, dest, bucket, merge, skipExisting, fallback } = req.body;
  if (!folderId) return res.status(400).json({ error: 'Select a OneDrive folder first' });
  if (!['auto', 'drive', 'photos', 'gcs'].includes(dest)) return res.status(400).json({ error: 'bad destination' });
  if (dest === 'gcs' && !bucket) return res.status(400).json({ error: 'bucket required' });
  const r = db.prepare('insert into jobs(folder_id, folder_name, dest, bucket, merge, skip_existing, fallback) values(?,?,?,?,?,?,?)')
    .run(folderId, folderName || 'OneDrive', dest, bucket || null, merge === true ? 1 : 0, skipExisting === false ? 0 : 1, fallback === true ? 1 : 0);
  worker.start(r.lastInsertRowid);
  res.json({ id: r.lastInsertRowid });
}));

app.get('/api/jobs', wrap(async (req, res) => {
  const jobs = db.prepare('select * from jobs order by id desc').all().map((j) => {
    const rows = db.prepare('select status, count(*) n, coalesce(sum(size),0) bytes from files where job_id=? group by status').all(j.id);
    const by = Object.fromEntries(rows.map((r) => [r.status, { n: r.n, bytes: r.bytes }]));
    const current = db.prepare("select dir, name, size from files where job_id=? and status='active' order by id limit 1").get(j.id) || null;
    const failed = db.prepare("select dir, name, error from files where job_id=? and status='failed' limit 20").all(j.id);
    const skippedFiles = db.prepare("select dir, name, error from files where job_id=? and status='skipped' order by id limit 500").all(j.id);
    const doneBytes = by.done?.bytes || 0;
    const remainingBytes = (by.pending?.bytes || 0) + (by.active?.bytes || 0);
    const startedAt = Date.parse(`${j.created_at}Z`);
    const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(1, (Date.now() - startedAt) / 1000) : 0;
    const active = worker.isRunning(j.id);
    const avgBytesPerSecond = doneBytes && elapsedSeconds ? doneBytes / elapsedSeconds : 0;
    const bytesPerSecond = active ? meter.rate(j.id) : null; // last 30 seconds
    const etaSeconds = !remainingBytes ? 0 : (bytesPerSecond ? Math.ceil(remainingBytes / bytesPerSecond) : null);
    return { ...j, by, active, current, failed, skippedFiles, etaSeconds, bytesPerSecond, avgBytesPerSecond };
  });
  res.json(jobs);
}));

app.post('/api/jobs/:id/pause', wrap(async (req, res) => { worker.pause(Number(req.params.id)); res.json({ ok: true }); }));
app.post('/api/jobs/:id/resume', wrap(async (req, res) => { worker.start(Number(req.params.id)); res.json({ ok: true }); }));
app.post('/api/jobs/:id/retry', wrap(async (req, res) => { worker.retryFailed(Number(req.params.id)); res.json({ ok: true }); }));
app.post('/api/jobs/:id/skipped-to-drive', wrap(async (req, res) => { worker.skippedToDrive(Number(req.params.id)); res.json({ ok: true }); }));

function skippedFiles(jobId) {
  return db.prepare("select id, job_id, item_id, dir, name, size, mime, error from files where job_id=? and status='skipped' order by id").all(jobId);
}

app.get('/api/jobs/:id/skipped', (req, res) => {
  res.json(skippedFiles(Number(req.params.id)));
});

app.get('/api/jobs/:id/skipped.csv', (req, res) => {
  const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const files = skippedFiles(Number(req.params.id));
  const columns = ['id', 'job_id', 'item_id', 'dir', 'name', 'size', 'mime', 'error'];
  const csv = [columns, ...files.map((file) => columns.map((column) => file[column]))]
    .map((row) => row.map(escapeCsv).join(',')).join('\r\n') + '\r\n';
  res.attachment(`job-${Number(req.params.id)}-skipped-files.csv`).type('text/csv').send(csv);
});

app.get('/api/files/:id/open', wrap(async (req, res) => {
  const file = db.prepare("select item_id from files where id=? and status='skipped'").get(Number(req.params.id));
  if (!file) return res.status(404).send('Skipped file not found');
  const oneDriveItem = await ms.item(file.item_id);
  if (!oneDriveItem.webUrl) return res.status(404).send('OneDrive web URL not found');
  res.redirect(oneDriveItem.webUrl);
}));

app.get('/api/files/:id/download', wrap(async (req, res) => {
  const file = db.prepare("select item_id from files where id=? and status='skipped'").get(Number(req.params.id));
  if (!file) return res.status(404).send('Skipped file not found');
  const url = await ms.downloadUrl(file.item_id);
  if (!url) return res.status(404).send('Download URL not found');
  res.redirect(url);
}));

app.get('/api/jobs/:id/skipped.zip', async (req, res) => {
  const jobId = Number(req.params.id);
  const files = db.prepare("select item_id, dir, name from files where job_id=? and status='skipped' order by id").all(jobId);
  if (!files.length) return res.status(404).send('No skipped files for this job');
  const archive = typeof archiver === 'function' ? archiver('zip', { zlib: { level: 0 } }) : new ZipArchive({ zlib: { level: 0 } });
  res.attachment(`job-${jobId}-skipped-files.zip`);
  archive.on('error', (err) => { if (!res.headersSent) res.status(500); res.destroy(err); });
  archive.pipe(res);
  try {
    for (const file of files) {
      const stream = Readable.fromWeb(await ms.reader(file.item_id).stream());
      archive.append(stream, { name: `${file.dir}/${file.name}`.replaceAll('\\', '/') });
      await new Promise((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
      });
    }
    await archive.finalize();
  } catch (e) {
    archive.destroy(e);
    if (!res.headersSent) res.status(500).send(e.message);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`Open http://localhost:${port}`);
  worker.resumeAll();
  const keepAlive = () => { ms.keepAlive(); g.keepAlive(); };
  keepAlive();
  setInterval(keepAlive, 5 * 60 * 1000);
});
