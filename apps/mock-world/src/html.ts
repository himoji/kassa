/*
 * Minimal HTML shell for mock-world pages. Every page shows the "Simulated" banner (spec §0, §17);
 * no real brand names or logos. All interpolated values go through `esc` (HTML-escaped).
 */

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function page(title: string, body: string, opts: { narrow?: boolean; script?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} (simulated)</title>
<style>
  :root { color-scheme: light dark; --fg:#111827; --bg:#f8fafc; --card:#ffffff; --muted:#6b7280; --accent:#1d4ed8; --ok:#047857; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e5e7eb; --bg:#0b1120; --card:#111827; --muted:#9ca3af; --accent:#60a5fa; --ok:#34d399; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--fg); background:var(--bg); }
  .banner { position:sticky; top:0; z-index:10; background:#f59e0b; color:#111827; text-align:center; font-weight:700; padding:6px 12px; letter-spacing:.04em; }
  main { max-width:${opts.narrow ? "420px" : "860px"}; margin:0 auto; padding:20px 16px 48px; }
  .card { background:var(--card); border-radius:14px; padding:16px; margin:12px 0; box-shadow:0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size:1.4rem; margin:.4rem 0 1rem; } h2 { font-size:1.1rem; margin:0 0 .6rem; }
  .muted { color:var(--muted); font-size:.9rem; }
  .amount { font-size:2rem; font-weight:700; }
  button, .btn { min-height:44px; min-width:44px; padding:10px 18px; border-radius:10px; border:0; background:var(--accent); color:#fff; font-weight:600; font-size:1rem; cursor:pointer; }
  button[disabled] { opacity:.5; cursor:not-allowed; }
  input { min-height:44px; padding:8px 10px; border-radius:8px; border:1px solid var(--muted); font-size:1rem; width:100%; background:transparent; color:inherit; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85rem; word-break:break-all; }
  table { width:100%; border-collapse:collapse; } td, th { text-align:left; padding:6px 4px; border-bottom:1px solid rgba(127,127,127,.25); }
  .status { font-weight:700; } .ok { color:var(--ok); } .bad { color:var(--bad); }
  a { color:var(--accent); }
</style>
</head>
<body>
<div class="banner" role="note">SIMULATED - demo environment, no real money moves</div>
<main>
${body}
</main>
${opts.script ? `<script>${opts.script}</script>` : ""}
</body>
</html>`;
}

/**
 * (added 2026-10-19) Page script helper for the operator screens (kitchen, supplier portals): `opFetch(url, init)` is
 * fetch with the operator key (the demo admin token, the same browser key the Stage keeps) as x-kassa-demo-token. On a
 * locked build their JSON routes are admin-only (access.ts): the first 401 asks for the key once per page load; without
 * it the page shows `#opnote` and stays read-only. Local development never answers 401, so nothing is asked there.
 */
export const OPERATOR_FETCH_JS = `
const OP_KEY_STORE = 'kassa:stageKey';
let opAsked = false;
function opKey() { try { return localStorage.getItem(OP_KEY_STORE) || ''; } catch (e) { return ''; } }
function opNote(show) { const n = document.getElementById('opnote'); if (n) n.hidden = !show; }
async function opFetch(url, init) {
  init = init || {};
  const send = () => { const h = Object.assign({}, init.headers || {}); const k = opKey(); if (k) h['x-kassa-demo-token'] = k; return fetch(url, Object.assign({}, init, { headers: h })); };
  let res = await send();
  if (res.status === 401 && !opAsked) {
    opAsked = true;
    const typed = window.prompt('Operator key (the demo admin token). This screen shows every customer\\'s orders:');
    if (typed) { try { localStorage.setItem(OP_KEY_STORE, typed.trim()); } catch (e) {} res = await send(); }
  }
  opNote(res.status === 401);
  return res;
}`;

/** The note an operator screen shows when its data needs the operator key (OPERATOR_FETCH_JS). */
export const OPERATOR_NOTE_HTML = `<p id="opnote" class="card muted" hidden>On this deployment this screen is for the demo operator: it shows and moves every customer's orders. Reload and enter the operator key, or follow your own order in the Kassa app.</p>`;
