const db = require('./db');

// User-editable settings, stored in the maps table so they survive restarts.
const DEFAULTS = { concurrency: Number(process.env.CONCURRENCY || 4), speedLimitMBps: 0 };
const LIMITS = { concurrency: [1, 16], speedLimitMBps: [0, 1000] };
let cache = null;

function get() {
  if (cache) return cache;
  const s = { ...DEFAULTS };
  for (const r of db.prepare("select key, value from maps where kind='setting'").all()) {
    if (r.key in s) s[r.key] = Number(r.value);
  }
  cache = s;
  return s;
}

function set(patch) {
  const next = { ...get() };
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    if (patch[k] === undefined) continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be between ${min} and ${max}`);
    next[k] = k === 'concurrency' ? Math.round(v) : v;
  }
  const save = db.prepare("insert or replace into maps(kind, key, value) values('setting', ?, ?)");
  for (const k of Object.keys(LIMITS)) save.run(k, String(next[k]));
  cache = next;
  return next;
}

module.exports = { get, set };
