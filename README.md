# OneDrive → Google Drive / Photos / Cloud Storage

Local web app that copies a OneDrive folder (300 GB+ is fine) to Google Drive, a Google Photos album, or a Cloud Storage bucket.
It streams data in 16 MB chunks (nothing is stored on disk), keeps job state in SQLite, resumes after a crash, and honours throttling (HTTP 429 / Retry-After).

## 1. Prerequisites
- Node.js 18+ (`node -v`)
- Google account with enough free space (300 GB+, e.g. Google One 2 TB). Drive allows ~750 GB uploads per day.

## 2. Microsoft setup
1. https://entra.microsoft.com → App registrations → New registration.
2. Supported account types: include personal Microsoft accounts if your OneDrive is personal; set `MS_TENANT=consumers` (or `common`).
3. Redirect URI (Web): `http://localhost:3000/auth/microsoft/callback`
4. API permissions → Microsoft Graph → Delegated: `Files.Read`, `User.Read`, `offline_access`.
5. Certificates & secrets → New client secret → copy the **Value** into `MS_CLIENT_SECRET`. Application (client) ID → `MS_CLIENT_ID`.

## 3. Google setup
1. https://console.cloud.google.com → create project.
2. APIs & Services → Library → enable **Google Drive API**, **Photos Library API**, **Cloud Storage** (JSON API).
3. OAuth consent screen: External, Testing mode, add your own Google account under **Test users**. Add scopes: `drive.file`, `photoslibrary.appendonly`, `devstorage.read_write`.
4. Credentials → Create OAuth client ID → Web application → redirect URI `http://localhost:3000/auth/google/callback`.
5. Copy the ID/secret into `.env`.
6. For Cloud Storage only: create a bucket and make sure your Google account has Storage Object Creator/Admin on it.

## 4. Run
```bash
cp .env.example .env      # then fill it in
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into TOKEN_KEY
npm install
npm start
```
Open http://localhost:3000, connect both accounts, pick a folder, choose a destination, Start.

## 5. Test plan (do not skip)
1. A folder with 3 small files → check Drive.
2. A folder with a few photos/videos → check the new Photos album.
3. ~1 GB folder, then ~20 GB, then the full 300 GB.
4. Kill the server mid-transfer, restart → job continues from pending files.

## Behaviour and limits
- Photos: upload-only API. Albums are created by the app; items in an album are limited (20,000). Photos accepts images ≤ 200 MB and videos ≤ 10 GB; in *Auto* mode larger/other files go to Drive.
- Folders → albums are named `Folder - Sub - Sub`. Photos may not store original quality for every format.
- A file interrupted right after upload completes may be uploaded twice on retry (rare duplicate).
- Failed files are retried 4 times; use "Retry failed" afterwards.
- Tokens are stored AES-256-GCM encrypted (key = `TOKEN_KEY`). The server listens on 127.0.0.1 only. Never commit `.env`.
- Run it on a VPS or a machine with a fast connection for best speed (cloud-to-cloud traffic passes through the app).
