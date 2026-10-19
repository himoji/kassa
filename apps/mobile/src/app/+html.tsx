import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

// Brand tokens (src/theme/tokens.ts): light background #f6f7f9, dark background #0b0d10,
// brand primary #0e1116 (readynative.config.ts). Keep in sync with public/manifest.webmanifest.
const LIGHT_BG = "#f6f7f9";
const DARK_BG = "#0b0d10";

// Safe areas: no body padding here. Screens render inside react-native-safe-area-context's
// SafeAreaView, which on web reads env(safe-area-inset-*) itself (NativeSafeAreaProvider.web),
// so adding padding on body would double it. This file only sets the background so the
// overscroll/notch area matches the app in standalone mode.
const BASE_CSS = `
html, body { background-color: ${LIGHT_BG}; }
@media (prefers-color-scheme: dark) {
  html, body { background-color: ${DARK_BG}; }
}`;

// Service worker: production only, and never on localhost (dev servers and local preview).
const SW_REGISTER = `if ('serviceWorker' in navigator && location.hostname !== 'localhost' && !location.hostname.startsWith('127.')) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
}`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>Kassa</title>

        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" type="image/svg+xml" href="/icons/logo-mark.svg" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />

        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Kassa" />

        <meta name="theme-color" media="(prefers-color-scheme: light)" content={LIGHT_BG} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={DARK_BG} />

        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: BASE_CSS }} />
        {process.env.NODE_ENV === "production" ? (
          <script dangerouslySetInnerHTML={{ __html: SW_REGISTER }} />
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
