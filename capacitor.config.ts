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
    // Keep blaksyd.com navigations INSIDE the app webview (otherwise Capacitor
    // hands remote hosts off to external Safari). External hosts (e.g. Google
    // OAuth) still open in the system browser, which is what we want for auth.
    allowNavigation: ['blaksyd.com', '*.blaksyd.com'],
  },
};

export default config;
