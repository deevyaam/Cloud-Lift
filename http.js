const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with retry on network errors, 429 and 5xx. Honors Retry-After. Body must be re-sendable (string/Buffer).
async function http(url, opts = {}, tries = 6) {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(url, opts);
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(Math.min(2 ** i * 1000, 30000));
      continue;
    }
    if ((r.status === 429 || r.status >= 500) && i < tries) {
      const ra = Number(r.headers.get('retry-after'));
      await sleep(ra ? ra * 1000 : Math.min(2 ** i * 1000, 60000));
      continue;
    }
    return r;
  }
}

module.exports = { http, sleep };
