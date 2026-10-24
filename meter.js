const { sleep } = require('./http');
const settings = require('./settings');

// Measures recent transfer speed per job and enforces the global speed limit.
const WINDOW = 30000;
const samples = new Map(); // jobId -> [[time, bytes]]
let nextFree = 0;

async function throttle(bytes) {
  const limit = settings.get().speedLimitMBps * 1024 * 1024;
  if (!limit) return;
  const now = Date.now();
  const start = Math.max(now, nextFree);
  nextFree = start + (bytes / limit) * 1000;
  if (start > now) await sleep(start - now);
}

function prune(list, now) {
  while (list.length && now - list[0][0] > WINDOW) list.shift();
}

function record(jobId, bytes) {
  const now = Date.now();
  if (!samples.has(jobId)) samples.set(jobId, []);
  const list = samples.get(jobId);
  list.push([now, bytes]);
  prune(list, now);
}

// Bytes per second over the last 30 seconds.
function rate(jobId) {
  const list = samples.get(jobId);
  if (!list) return 0;
  const now = Date.now();
  prune(list, now);
  if (!list.length) return 0;
  const span = Math.min(WINDOW, Math.max(5000, now - list[0][0]));
  return list.reduce((sum, [, n]) => sum + n, 0) / (span / 1000);
}

// Wraps a reader ({ range, stream }) so every byte read is throttled and counted.
function metered(jobId, reader) {
  return {
    async range(s, e) {
      await throttle(e - s + 1);
      const b = await reader.range(s, e);
      record(jobId, b.length);
      return b;
    },
    async stream() {
      const body = await reader.stream();
      return ReadableStream.from((async function* () {
        for await (const chunk of body) {
          await throttle(chunk.length);
          record(jobId, chunk.length);
          yield chunk;
        }
      })());
    },
  };
}

module.exports = { metered, rate };
