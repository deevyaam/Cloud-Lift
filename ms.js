const tokens = require('./tokens');
const { http } = require('./http');

const P = 'microsoft';
const tenant = () => process.env.MS_TENANT || 'common';
const redirect = () => `${process.env.BASE_URL || 'http://localhost:3000'}/auth/microsoft/callback`;
let refreshing = null;
let authError = null; // set when the saved sign-in stops working
let acct = null;

function authFailure(message) {
  const e = new Error(message);
  e.auth = true;
  return e;
}

function authUrl(state) {
  if (!process.env.MS_CLIENT_ID) {
    throw new Error('Microsoft OAuth is not configured. Add MS_CLIENT_ID to .env and restart the server.');
  }
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize?` + new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID, response_type: 'code', redirect_uri: redirect(),
    response_mode: 'query', scope: 'offline_access Files.Read User.Read', prompt: 'select_account', state,
  });
}

async function tokenReq(params) {
  const r = await http(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET,
      redirect_uri: redirect(), ...params,
    }),
    tokenRequest: true,
  }, 2);
  const j = await r.json();
  if (!r.ok) {
    const message = j.error_description || 'Microsoft token error';
    if (r.status === 400 || r.status === 401) {
      authError = 'Microsoft sign-in expired. Reconnect Microsoft.';
      throw authFailure(message);
    }
    throw new Error(message);
  }
  authError = null;
  const prev = tokens.load(P) || {};
  tokens.save(P, {
    access_token: j.access_token,
    refresh_token: j.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (j.expires_in - 120) * 1000,
  });
}

async function exchange(code) {
  await tokenReq({ grant_type: 'authorization_code', code });
  acct = null;
}

function refresh(t) {
  if (!refreshing) {
    refreshing = tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function token() {
  const t = tokens.load(P);
  if (!t) throw authFailure('Microsoft not connected');
  if (Date.now() < t.expires_at) return t.access_token;
  await refresh(t);
  return tokens.load(P).access_token;
}

// Called on a timer so the sign-in is renewed before it expires, even when idle.
async function keepAlive() {
  const t = tokens.load(P);
  if (!t || Date.now() < t.expires_at - 10 * 60 * 1000) return;
  try { await refresh(t); } catch (e) { console.warn(`[microsoft] token refresh failed: ${e.message}`); }
}

const connected = () => !!tokens.load(P);
const problem = () => (connected() ? authError : null);

async function account() {
  if (!acct && connected()) {
    const me = await graph('/me?$select=displayName,mail,userPrincipalName');
    acct = { name: me.displayName, email: me.mail || me.userPrincipalName };
  }
  return acct;
}

function disconnect() {
  tokens.remove(P);
  acct = null;
  authError = null;
}

async function graph(u) {
  const url = u.startsWith('http') ? u : 'https://graph.microsoft.com/v1.0' + u;
  const r = await http(url, { headers: { Authorization: 'Bearer ' + (await token()) } });
  if (!r.ok) throw new Error(`Graph ${r.status}: ${await r.text()}`);
  return r.json();
}

async function children(id) {
  const out = [];
  let u = (id === 'root' ? '/me/drive/root' : `/me/drive/items/${id}`) +
    '/children?$top=200&$select=id,name,size,folder,file';
  while (u) {
    const j = await graph(u);
    out.push(...j.value);
    u = j['@odata.nextLink'];
  }
  return out;
}

async function downloadUrl(id) {
  const j = await graph(`/me/drive/items/${id}?$select=id,@microsoft.graph.downloadUrl`);
  return j['@microsoft.graph.downloadUrl'] || null;
}

async function item(id) {
  return graph(`/me/drive/items/${encodeURIComponent(id)}?$select=id,name,webUrl`);
}

// Reads a OneDrive file in byte ranges. Graph normally returns a short-lived
// download URL, but some files expose only the /content endpoint.
function reader(id) {
  let url = null;
  const content = () => `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(id)}/content`;
  return {
    async range(s, e) {
      for (let a = 0; ; a++) {
        if (!url) url = await downloadUrl(id);
        const headers = { Range: `bytes=${s}-${e}` };
        if (!url) headers.Authorization = 'Bearer ' + (await token());
        const r = await http(url || content(), { headers });
        if (r.status === 206 || (r.status === 200 && s === 0)) {
          const b = Buffer.from(await r.arrayBuffer());
          return b.length > e - s + 1 ? b.subarray(0, e - s + 1) : b;
        }
        if ([401, 403, 404].includes(r.status) && a < 3) { url = null; continue; }
        throw new Error('OneDrive download failed: ' + r.status);
      }
    },
    async stream() {
      url = await downloadUrl(id);
      const headers = url ? {} : { Authorization: 'Bearer ' + (await token()) };
      const r = await http(url || content(), { headers });
      if (!r.ok) throw new Error('OneDrive download failed: ' + r.status);
      return r.body;
    },
  };
}

module.exports = { authUrl, exchange, connected, problem, account, disconnect, keepAlive, children, item, downloadUrl, reader };
