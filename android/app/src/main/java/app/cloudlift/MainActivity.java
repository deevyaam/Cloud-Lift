package app.cloudlift;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * CloudLift for Android: a full-screen view of the user's own CloudLift server.
 * Transfers run on the server; the app is a remote control for it.
 * Google blocks its sign-in inside embedded browsers, so sign-ins, the Google Photos picker
 * and links to other sites open in the phone's browser instead.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "cloudlift";
    private static final String KEY_SERVER = "server";
    private static final String SETUP = "file:///android_asset/setup.html";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private volatile String server;     // e.g. https://cloudlift.example.com, no trailing slash
    private volatile String currentUrl = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " CloudLiftApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "CloudLiftApp");
        web.setWebViewClient(new Client());
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, userAgent, disposition, mime));

        server = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null);
        if (state == null || web.restoreState(state) == null) web.loadUrl(server != null ? server + "/" : SETUP);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // Coming back from the browser after signing in or picking photos: let the page refresh now.
        web.evaluateJavascript("document.visibilityState==='visible'&&document.dispatchEvent(new Event('visibilitychange'))", null);
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); // cloudlift://return: the app simply comes back to the front
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    // ---------- Navigation ----------

    private boolean isOwn(Uri u) {
        if (u.toString().startsWith("file:///android_asset/")) return true;
        String srv = server;
        if (srv == null) return false;
        Uri s = Uri.parse(srv);
        return s.getScheme().equalsIgnoreCase(u.getScheme())
                && s.getHost().equalsIgnoreCase(u.getHost())
                && s.getPort() == u.getPort();
    }

    private void openExternal(String url) {
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (!scheme.equals("https") && !scheme.equals("http")) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show();
        }
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isOwn(request.getUrl())) return false;
            openExternal(request.getUrl().toString());
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            currentUrl = url;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // The server can't be reached and the page's own offline screen isn't installed yet.
            if (request.isForMainFrame() && !request.getUrl().toString().startsWith("file:")) {
                view.loadUrl(SETUP + "#unreachable");
            }
        }
    }

    // ---------- Downloads (for example the skipped-files list) ----------

    private void download(String url, String userAgent, String disposition, String mime) {
        if (!isOwn(Uri.parse(url))) {
            openExternal(url);
            return;
        }
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        String cookie = CookieManager.getInstance().getCookie(url); // keeps the CloudLift sign-in
        if (cookie != null) req.addRequestHeader("Cookie", cookie);
        req.addRequestHeader("User-Agent", userAgent);
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, disposition, mime));
        ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
        Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
    }

    // ---------- Server address ----------

    /** Turns what the user typed into https://host[:port]; null if it isn't a usable address. */
    static String normalize(String input) {
        String t = input == null ? "" : input.trim();
        if (t.isEmpty()) return null;
        if (!t.contains("://")) t = "https://" + t;
        Uri u = Uri.parse(t);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if ((!scheme.equals("https") && !scheme.equals("http")) || u.getHost() == null || u.getHost().isEmpty()) return null;
        return scheme + "://" + u.getHost().toLowerCase() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    /** A CloudLift server serves its app manifest without signing in; check it before saving. */
    private void checkServer(String input) {
        String url = normalize(input);
        if (url == null) {
            reply(false, "That doesn't look like a web address. Example: https://cloudlift.example.com");
            return;
        }
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/manifest.webmanifest").openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            int code = c.getResponseCode();
            if (code != 200) throw new IllegalStateException("The server answered " + code + ". Is CloudLift up to date on it?");
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
                byte[] b = new byte[8192];
                for (int n; (n = in.read(b)) > 0 && buf.size() < 65536; ) buf.write(b, 0, n);
                JSONObject manifest = new JSONObject(buf.toString(StandardCharsets.UTF_8.name()));
                if (!"CloudLift".equals(manifest.optString("name"))) throw new IllegalStateException("That server isn't running CloudLift.");
            }
            server = url;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply();
            main.post(() -> {
                web.clearHistory();
                web.loadUrl(url + "/");
            });
        } catch (java.net.UnknownHostException e) {
            reply(false, "Couldn't find that address. Check the spelling and your internet connection.");
        } catch (javax.net.ssl.SSLException e) {
            reply(false, "The server's HTTPS certificate isn't valid.");
        } catch (Exception e) {
            String msg = e instanceof IllegalStateException ? e.getMessage() : "Couldn't reach CloudLift at that address.";
            reply(false, msg);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void reply(boolean ok, String message) {
        main.post(() -> web.evaluateJavascript("window.onServerResult&&onServerResult(" + ok + "," + JSONObject.quote(message) + ")", null));
    }

    // ---------- JavaScript bridge (window.CloudLiftApp) ----------

    private class Bridge {
        /** Opens a link in the phone's browser (sign-ins, the Google Photos picker). */
        @JavascriptInterface
        public void openExternal(String url) {
            main.post(() -> MainActivity.this.openExternal(url));
        }

        /** Shows the server address screen again. */
        @JavascriptInterface
        public void changeServer() {
            main.post(() -> web.loadUrl(SETUP));
        }

        @JavascriptInterface
        public String getServer() {
            return server == null ? "" : server;
        }

        /** Only the built-in setup screen may change which server the app opens. */
        @JavascriptInterface
        public void connect(String input) {
            if (!currentUrl.startsWith(SETUP)) return;
            io.execute(() -> checkServer(input));
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }
}
