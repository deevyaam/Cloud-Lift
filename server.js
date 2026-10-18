require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const ms = require('./ms');
const g = require('./google');
const worker = require('./worker');

const app = express();
app.use(express.json());
app.use(express.static('public'));
const states = new Set();

function login(provider) {
  app.get(`/auth/${provider.name}`, (req, res) => {
    const s = crypto.randomUUID();
    states.add(s);
    try {
      res.redirect(provider.mod.authUrl(s));
    } catch (e) {
      states.delete(s);
      res.status(500).send(`
        <main style="font-family:system-ui;max-width:680px;margin:64px auto;padding:0 24px;color:#18212f">
          <h1>Microsoft connection is not configured</h1>
          <p>${e.message}</p>
          <p>Copy <code>.env.example</code> to <code>.env</code>, add your Microsoft Entra app values, then restart the website.</p>
          <a href="/">← Back to CloudLift</a>
        </main>`);
    }
  });
  app.get(`/auth/${provider.name}/callback`, async (req, res) => {
    if (!states.delete(req.query.state)) return res.status(400).send('Invalid state');
    try {
      await provider.mod.exchange(req.query.code);
      res.redirect('/');
    } catch (e) {
      res.status(500).send(e.message);
    }
  });
}
login({ name: 'microsoft', mod: ms });
login({ name: 'google', mod: g });

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

app.get('/api/status', (req, res) => res.json({
  microsoft: ms.connected(),
  google: g.connected(),
  microsoftConfigured: !!process.env.MS_CLIENT_ID && !!process.env.MS_CLIENT_SECRET,
  googleConfigured: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
}));

app.get('/api/ms/children', wrap(async (req, res) => {
  const items = await ms.children(req.query.id || 'root');
  res.json(items.map((i) => ({ id: i.id, name: i.name, size: i.size, isFolder: !!i.folder })));
}));

app.post('/api/jobs', wrap(async (req, res) => {
  const { folderId, folderName, dest, bucket } = req.body;
  if (!['auto', 'drive', 'photos', 'gcs'].includes(dest)) return res.status(400).json({ error: 'bad destination' });
  if (dest === 'gcs' && !bucket) return res.status(400).json({ error: 'bucket required' });
  const r = db.prepare('insert into jobs(folder_id, folder_name, dest, bucket) values(?,?,?,?)')
    .run(folderId, folderName || 'OneDrive', dest, bucket || null);
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
    const remainingBytes = Math.max(0, Object.values(by).reduce((sum, row) => sum + row.bytes, 0) - doneBytes - (by.skipped?.bytes || 0));
    const startedAt = Date.parse(`${j.created_at}Z`);
    const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(1, (Date.now() - startedAt) / 1000) : 0;
    const bytesPerSecond = doneBytes && elapsedSeconds ? doneBytes / elapsedSeconds : 0;
    const etaSeconds = j.status === 'done' ? 0 : (bytesPerSecond && remainingBytes ? Math.ceil(remainingBytes / bytesPerSecond) : null);
    return { ...j, by, current, failed, skippedFiles, etaSeconds, bytesPerSecond };
  });
  res.json(jobs);
}));

app.post('/api/jobs/:id/pause', wrap(async (req, res) => { worker.pause(Number(req.params.id)); res.json({ ok: true }); }));
app.post('/api/jobs/:id/resume', wrap(async (req, res) => { worker.start(Number(req.params.id)); res.json({ ok: true }); }));
app.post('/api/jobs/:id/retry', wrap(async (req, res) => { worker.retryFailed(Number(req.params.id)); res.json({ ok: true }); }));

const port = process.env.PORT || 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`Open http://localhost:${port}`);
  worker.resumeAll();
});
