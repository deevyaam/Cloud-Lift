const tokens = require('./tokens');
const { http } = require('./http');

const P = 'microsoft';
const tenant = () => process.env.MS_TENANT || 'common';
const redirect = () => `${process.env.BASE_URL || 'http://localhost:3000'}/auth/microsoft/callback`;
let refreshing = null;

function authUrl(state) {
  if (!process.env.MS_CLIENT_ID) {
    throw new Error('Microsoft OAuth is not configured. Add MS_CLIENT_ID to .env and restart the server.');
  }
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize?` + new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID, response_type: 'code', redirect_uri: redirect(),
    response_mode: 'query', scope: 'offline_access Files.Read User.Read', state,
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
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || 'Microsoft token error');
  const prev = tokens.load(P) || {};
  tokens.save(P, {
    access_token: j.access_token,
    refresh_token: j.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (j.expires_in - 120) * 1000,
  });
}

const exchange = (code) => tokenReq({ grant_type: 'authorization_code', code });

async function token() {
  const t = tokens.load(P);
  if (!t) throw new Error('Microsoft not connected');
  if (Date.now() < t.expires_at) return t.access_token;
  if (!refreshing) {
    refreshing = tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
  return tokens.load(P).access_token;
}

const connected = () => !!tokens.load(P);

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

module.exports = { authUrl, exchange, connected, children, reader };
