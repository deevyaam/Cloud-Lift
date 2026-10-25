# Running your own copy of CloudLift

CloudLift is a **one-person app**: each copy connects to one Microsoft account and one Google account. To let other people use it, each person runs **their own copy**, either:

- **A. On their own computer** (simplest, nothing exposed to the internet), or
- **B. On a server (VPS)** they control, with a password and HTTPS, so transfers keep running when their computer is off.

Both need the same app keys from Microsoft and Google (step 1).

---

## 1. Create your app keys (once per person)

### Microsoft (OneDrive)
1. Go to the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: `CloudLift`. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
3. Redirect URI: platform **Web**, address `BASE_URL/auth/microsoft/callback`, for example:
   - on your computer: `http://localhost:3000/auth/microsoft/callback`
   - on a server: `https://cloudlift.example.com/auth/microsoft/callback`
4. Copy the **Application (client) ID** → `MS_CLIENT_ID`.
5. **Certificates & secrets** → **New client secret** → copy its **Value** (not the ID) → `MS_CLIENT_SECRET`. Note its expiry date and create a new one before then.
6. **API permissions** → **Add** → **Microsoft Graph** → **Delegated**: `Files.ReadWrite`, `User.Read`, `offline_access`.

### Google (Photos, Drive, Cloud Storage)
1. In [Google Cloud console](https://console.cloud.google.com), create a project (or use an existing one).
2. **APIs & Services → Library**, enable: **Google Drive API**, **Photos Library API**, **Google Photos Picker API**, and (only for buckets) **Cloud Storage JSON API**. Check the project selector at the top shows the right project; enabling in the wrong project is an easy mistake.
3. **Google Auth Platform** (OAuth consent screen): user type **External**, fill in the app name and your email.
4. **Clients → Create client** → **Web application**. Authorized redirect URI: `BASE_URL/auth/google/callback` (same pattern as Microsoft). Copy the **Client ID** and **Client secret** → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
5. **Audience**: while the app is in **Testing**, add your Google account under **Test users**. In Testing, Google makes you sign in again **every 7 days**. For a personal copy you can avoid that by pressing **Publish app** (status *In production*): Google then shows an "unverified app" warning at sign-in (click **Advanced → Go to CloudLift**), which is expected for your own app.

### Settings file
Copy `.env.example` to `.env` and fill in:

```ini
MS_CLIENT_ID=...
MS_CLIENT_SECRET=...
MS_TENANT=common
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
TOKEN_KEY=...           # 64 hex characters, see below
```

Generate `TOKEN_KEY` once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`TOKEN_KEY` encrypts your saved sign-ins. **Never change it** afterwards, or CloudLift forgets your sign-ins and you have to connect both accounts again.

---

## A. On your own computer

Needs [Node.js](https://nodejs.org) 22 or newer (24 recommended).

```bash
git clone https://github.com/deevyaam/Cloud-Lift.git
cd Cloud-Lift
npm install
npm start
```

Open http://localhost:3000. It only listens on your own computer, so no password is needed. For the Takeout metadata option, install [ExifTool](https://exiftool.org) and set `EXIFTOOL_PATH` in `.env`.

---

## B. On your own server (VPS)

You need: a Linux VPS (Ubuntu 24.04 works well) with a public IP, a domain or subdomain such as `cloudlift.example.com`, and enough disk for the largest file you copy times the number of files transferred at once (Google → OneDrive copies each file to disk first).

1. **Point the domain at the server**: add a DNS **A record** for `cloudlift.example.com` → your server's IP.
2. **Open only the needed ports** and install Docker:
   ```bash
   sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
   curl -fsSL https://get.docker.com | sudo sh
   ```
3. **Get CloudLift** onto the server:
   ```bash
   git clone https://github.com/deevyaam/Cloud-Lift.git cloudlift
   cd cloudlift
   ```
4. **Create `.env`** (`nano .env`) with the keys from step 1, plus:
   ```ini
   DOMAIN=cloudlift.example.com
   APP_PASSWORD=a-long-password-only-you-know
   ```
   In both the Microsoft and Google consoles, the redirect URIs must use `https://cloudlift.example.com/...`.
5. **Start it**:
   ```bash
   sudo docker compose up -d --build
   ```
   Caddy gets a free HTTPS certificate automatically. Open `https://cloudlift.example.com`, sign in with `APP_PASSWORD`, then connect your accounts.

Everyday commands (run in the `cloudlift` folder):

| Task | Command |
|---|---|
| See logs | `sudo docker compose logs -f app` |
| Update to the latest version | `git pull && sudo docker compose up -d --build` |
| Stop / start | `sudo docker compose stop` / `sudo docker compose start` |
| Back up the database | `sudo docker compose cp app:/data/transfer.db ./transfer-backup.db` |

**Google Takeout on a server**: upload the *extracted* export into the `takeout` folder next to `docker-compose.yml` (for example with `rsync` or `scp`), then in CloudLift use the path `/takeout/Takeout`.

### Install it on your phone
CloudLift is an installable web app, so a server copy can be added to a phone's home screen. The server does the transfers, and the phone is a remote control. It keeps working when the phone is locked or offline.
- **Android (Chrome):** open `https://cloudlift.example.com`, sign in, then tap **Install app** in the top bar, or use the ⋮ menu → **Add to home screen / Install app**.
- **iPhone (Safari):** tap **Share** → **Add to Home Screen**.

Installing needs HTTPS, which the Caddy setup above provides. A copy on your own computer can also be installed there from Chrome or Edge, but a phone can't reach a copy that only runs at `localhost`.

### Android app (APK)
The `android/` folder builds **CloudLift for Android** (`app.cloudlift`), a small app that opens your CloudLift server full screen. As with the installable web app, the server does the transfers.

- **Install:** copy `CloudLift-1.1.apk` to the phone and open it. Android asks to allow installing from that source (for example *Files* or *Chrome*); allow it once.
- **Connect:** on first launch, enter your server address (for example `https://cloudlift.example.com`) and sign in with `APP_PASSWORD`.
- **Signing in to Microsoft and Google** opens in the phone's browser, because Google doesn't allow its sign-in inside apps. The browser may ask for `APP_PASSWORD` once. When it shows "connected", tap **Return to CloudLift**. Choosing photos in Google Photos works the same way.
- To use a different server later: **Settings → Change server**.

Building it yourself (needs Android Studio, which provides the Android SDK and Java):

```bash
cd android
./gradlew assembleRelease
```

On Windows the build goes to `%LOCALAPPDATA%\CloudLift\android-build` (outside OneDrive, which locks build files). The signed APK is `app\outputs\apk\release\app-release.apk` there.

Release builds are signed with the key described in `android/keystore.properties` (not in git). **Back up `cloudlift-release.jks` and `keystore.properties` somewhere safe.** Android only installs updates signed with the same key, so if the key is lost, everyone has to uninstall CloudLift and install the new version fresh. Raise `versionCode` in `android/app/build.gradle` for every new release.

### Security notes
- CloudLift **refuses to start on a public address without `APP_PASSWORD`**, because anyone reaching it could use your connected accounts. Use a long, unique password; after 5 wrong attempts an address must wait 15 minutes.
- Keep `.env` private: it holds your app secrets, `TOKEN_KEY` and the password.
- Data passes through the server: check your VPS plan's bandwidth allowance before copying hundreds of GB.

---

## Sharing your own app keys instead (optional)
For copies running on other people's computers, you *can* give them your `MS_*` and `GOOGLE_*` values, because `http://localhost:3000/...` is the same redirect address for everyone. They still need their own `TOKEN_KEY`, and while your Google app is in **Testing** you must add each person as a **test user** (up to 100). Anyone with your secrets can act as your app, so only share them with people you trust; creating their own keys (step 1) is safer.
