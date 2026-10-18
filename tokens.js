const crypto = require('crypto');
const db = require('./db');

function key() {
  const k = process.env.TOKEN_KEY;
  if (!k || k.length !== 64) throw new Error('TOKEN_KEY must be 64 hex characters (see .env.example)');
  return Buffer.from(k, 'hex');
}

function save(provider, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const blob = Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  db.prepare('insert or replace into tokens(provider, data) values(?, ?)').run(provider, blob);
}

function load(provider) {
  const r = db.prepare('select data from tokens where provider = ?').get(provider);
  if (!r) return null;
  const b = Buffer.from(r.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}

module.exports = { save, load };
