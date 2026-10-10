# .well-known

`apple-app-site-association` (iOS universal links, no file extension) and `assetlinks.json`
(Android App Links) are generated from `readynative.config.ts` (`links` + bundle ids) by
`bun run gen:links` - do not edit by hand. Both must be served over https at `links.domain`
with `Content-Type: application/json`; `expo export -p web` ships `public/` as-is, so hosting
the web app at that domain is enough. iOS fetches the AASA on install; Android verifies via the
`autoVerify` intent filter that `app.config.ts` emits when `links.domain` is set.
