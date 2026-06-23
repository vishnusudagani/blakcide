import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.blaksyd.app',
  appName: 'Blaksyd',
  webDir: 'dist',
  // v1 ships as a thin native shell over the LIVE site. Netlify serves correct
  // content-types for the multi-page beta; Capacitor's bundled file server mis-
  // handles trailing-slash directory document loads (→ blank white). The app is
  // online-only (realtime chat) so there's no offline loss. The bundled dist
  // remains as a fallback. Revisit a bundled/SPA build for v2.
  server: {
    url: 'https://blaksyd.com/beta/',
    cleartext: false,
    errorPath: 'offline.html',     // branded fallback if the live site can't load (offline)
    // Keep blaksyd.com navigations INSIDE the app webview (otherwise Capacitor
    // hands remote hosts off to external Safari). External hosts (e.g. Google
    // OAuth) still open in the system browser, which is what we want for auth.
    allowNavigation: ['blaksyd.com', '*.blaksyd.com'],
  },
  // Native shell polish (config-only — applies to the remote-URL app without
  // touching the live web code).
  plugins: {
    SplashScreen: {
      launchShowDuration: 3000,      // hold the branded splash over the cold remote load
      launchAutoHide: true,
      launchFadeOutDuration: 400,
      backgroundColor: '#08091A',    // brand void
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'LIGHT',                // white status-bar content (the app is predominantly dark)
      backgroundColor: '#08091A',    // Android status-bar background
      overlaysWebView: false,
    },
    Keyboard: {
      resize: 'none',                // let the web app's visualViewport logic own the keyboard
    },
  },
};

export default config;
