let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(process.env.DB_PATH || 'transfer.db');
  db.pragma('journal_mode = WAL');
} catch (e) {
  // Node 24 ships SQLite, which keeps the app runnable when the native
  // better-sqlite3 binary is unavailable for the installed Node version.
  const { DatabaseSync } = require('node:sqlite');
  const native = new DatabaseSync(process.env.DB_PATH || 'transfer.db');
  db = {
    exec: (sql) => native.exec(sql),
    pragma: () => {},
    prepare: (sql) => {
      const statement = native.prepare(sql);
      return {
        run: (...args) => statement.run(...args),
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
      };
    },
  };
}
db.exec(`
create table if not exists tokens(provider text primary key, data text not null);
create table if not exists jobs(
  id integer primary key autoincrement, folder_id text, folder_name text,
  dest text, bucket text, status text default 'scanning', scanned integer default 0,
  error text, created_at text default current_timestamp);
create table if not exists files(
  id integer primary key autoincrement, job_id integer, item_id text, dir text, name text,
  size integer, mime text, status text default 'pending', retries integer default 0,
  error text, dest_kind text, dest_id text, unique(job_id, item_id));
create table if not exists maps(kind text, key text, value text, primary key(kind, key));
`);
const jobColumns = db.prepare('pragma table_info(jobs)').all().map((column) => column.name);
if (!jobColumns.includes('merge')) db.exec('alter table jobs add column merge integer default 0');
if (!jobColumns.includes('skip_existing')) db.exec('alter table jobs add column skip_existing integer default 0');
if (!jobColumns.includes('fallback')) db.exec('alter table jobs add column fallback integer default 0');
// Google -> OneDrive jobs: source is gphotos/gdrive/takeout, target_id is the OneDrive folder.
if (!jobColumns.includes('direction')) db.exec("alter table jobs add column direction text default 'to_google'");
if (!jobColumns.includes('source')) db.exec("alter table jobs add column source text default 'onedrive'");
if (!jobColumns.includes('target_id')) db.exec('alter table jobs add column target_id text');
if (!jobColumns.includes('target_name')) db.exec('alter table jobs add column target_name text');
db.exec(`
create index if not exists files_job_status on files(job_id, status);
create index if not exists files_item on files(item_id);
`);
module.exports = db;
