const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(error) {
  const cause = error?.cause;
  const details = [error?.message || String(error)];
  if (cause?.code) details.push(cause.code);
  if (cause?.address) details.push(`address=${cause.address}`);
  if (cause?.port) details.push(`port=${cause.port}`);
  return details.join(' - ');
}

// fetch with retry on network errors, 429 and 5xx. Honors Retry-After. Body must be re-sendable (string/Buffer).
async function http(url, opts = {}, tries = 6) {
  const { tokenRequest = false, ...fetchOpts } = opts;
  for (let i = 0; ; i++) {
    let r;
    try {
      const requestOpts = tokenRequest ? { ...fetchOpts, signal: AbortSignal.timeout(30000) } : fetchOpts;
      r = await fetch(url, requestOpts);
    } catch (e) {
      console.error(`[http] ${new URL(url).origin}${new URL(url).pathname}: ${describeError(e)}`);
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

module.exports = { http, sleep, describeError };
