/*
 * Static assets for the Demo Stage (/mock/stage/stage.css and /mock/stage/stage.js). Served from memory, no CDN and no
 * web fonts, so the stage works offline. Neutral slate palette on purpose: the screens stand for generic outside
 * services, not for any real wallet or bank brand.
 */

export const STAGE_CSS: string = `
:root {
  color-scheme: light dark;
  --bg: #e5e7eb;
  --screen: #f8fafc;
  --card: #ffffff;
  --fg: #0f172a;
  --muted: #64748b;
  --line: rgba(100, 116, 139, .25);
  --accent: #334155;
  --accent-fg: #ffffff;
  --ok: #15803d;
  --bad: #b91c1c;
  --warn: #b45309;
  --info: #1e40af;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #020617;
    --screen: #0b1120;
    --card: #111827;
    --fg: #e5e7eb;
    --muted: #94a3b8;
    --accent: #cbd5e1;
    --accent-fg: #0f172a;
    --ok: #4ade80;
    --bad: #f87171;
    --warn: #fbbf24;
    --info: #93c5fd;
  }
}

body.stage {
  margin: 0;
  background: var(--bg);
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 24px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.45;
  color: var(--fg);
}

.device {
  width: 390px;
  height: 844px;
  background: var(--screen);
  color: var(--fg);
  border-radius: 44px;
  box-shadow: 0 24px 60px rgba(15, 23, 42, .28);
  overflow-y: auto;
  position: relative;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

@media (max-width: 500px) {
  body.stage { padding: 0; display: block; }
  .device {
    width: 100%;
    height: auto;
    min-height: 100dvh;
    border-radius: 0;
    box-shadow: none;
  }
}

.ribbon {
  position: absolute;
  top: 10px;
  right: 14px;
  z-index: 5;
  background: #f59e0b;
  color: #111827;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: 3px 10px;
  border-radius: 999px;
}

.appbar {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
  background: var(--screen);
  border-bottom: 1px solid var(--line);
}
.appbar .back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-left: -10px;
  font-size: 28px;
  line-height: 1;
  text-decoration: none;
  color: var(--fg);
  box-sizing: border-box;
}
.appname { font-weight: 700; }

.screen {
  padding: 12px 16px 24px;
  flex: 1;
}

.card {
  background: var(--card);
  border-radius: 16px;
  padding: 16px;
  margin: 12px 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .08);
}

h1 { font-size: 1.35rem; margin: .4rem 0 .6rem; }
h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
.muted { color: var(--muted); font-size: .9rem; }
.amount { font-size: 2.2rem; font-weight: 700; }
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .8rem;
  word-break: break-all;
}

.btn {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 52px;
  margin: 8px 0;
  padding: 14px 16px;
  border: 0;
  border-radius: 14px;
  font-family: inherit;
  font-size: 1.05rem;
  font-weight: 600;
  text-align: center;
  text-decoration: none;
  background: var(--accent);
  color: var(--accent-fg);
  cursor: pointer;
}
.btn.secondary {
  background: transparent;
  border: 1.5px solid var(--accent);
  color: var(--fg);
}
.btn.danger {
  background: var(--bad);
  color: #fff;
}
.btn[disabled] { opacity: .5; cursor: not-allowed; }
.btn:focus-visible { outline: 3px solid var(--info); outline-offset: 2px; }

input.field {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 48px;
  margin: 8px 0;
  border-radius: 12px;
  border: 1px solid var(--line);
  padding: 10px 12px;
  font-size: 1rem;
  font-family: inherit;
  background: transparent;
  color: inherit;
}

.status {
  border-left: 6px solid var(--muted);
  background: var(--card);
  border-radius: 12px;
  padding: 12px 14px;
  margin: 10px 0;
}
.status[data-tone="ok"] { border-left-color: var(--ok); }
.status[data-tone="bad"] { border-left-color: var(--bad); }
.status[data-tone="warn"] { border-left-color: var(--warn); }
.status[data-tone="info"] { border-left-color: var(--info); }
.status[data-tone="ok"] .status-label { color: var(--ok); }
.status[data-tone="bad"] .status-label { color: var(--bad); }
.status[data-tone="warn"] .status-label { color: var(--warn); }
.status[data-tone="info"] .status-label { color: var(--info); }
.status-label {
  display: inline-block;
  font-size: .72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: var(--muted);
}
.status-title { display: block; font-weight: 700; }
.status-detail { display: block; color: var(--muted); font-size: .9rem; }

.chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: .75rem;
  font-weight: 700;
  border: 1px solid var(--line);
}
.chip.ok { color: var(--ok); }
.chip.bad { color: var(--bad); }
.chip.warn { color: var(--warn); }

.tap-zone {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 180px;
  height: 180px;
  margin: 16px auto;
  border-radius: 50%;
  border: 2px dashed var(--muted);
  background: transparent;
  color: var(--fg);
  font-family: inherit;
  font-size: 1rem;
  font-weight: 700;
  text-align: center;
  cursor: pointer;
}
.tap-zone:focus-visible { outline: 3px solid var(--info); outline-offset: 2px; }
@keyframes stage-pulse {
  0% { box-shadow: 0 0 0 0 rgba(100, 116, 139, .55); }
  100% { box-shadow: 0 0 0 28px rgba(100, 116, 139, 0); }
}
@media (prefers-reduced-motion: no-preference) {
  .tap-zone.tapping { animation: stage-pulse 1.2s ease-out 2; }
}

.pay-card {
  aspect-ratio: 1.586;
  box-sizing: border-box;
  margin: 12px 0;
  border-radius: 16px;
  padding: 18px;
  color: #f8fafc;
  background: linear-gradient(135deg, #475569, #1e293b);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.pay-card .row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: .9rem;
}
.pay-card .num {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: .15em;
  font-size: 1.2rem;
}
.pay-card .muted { color: #cbd5e1; }

.qr-box {
  box-sizing: border-box;
  width: 200px;
  height: 200px;
  margin: 12px auto;
  border-radius: 8px;
  background: repeating-conic-gradient(var(--fg) 0 25%, var(--card) 0 50%) 0 0 / 20px 20px;
  border: 10px solid var(--card);
  outline: 1px solid var(--line);
}

.warning-block {
  border: 2px solid var(--bad);
  border-radius: 14px;
  padding: 12px;
  margin: 10px 0;
  color: var(--bad);
  font-weight: 600;
}

.timeline {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}
.timeline li {
  position: relative;
  padding: 8px 0 8px 28px;
  color: var(--muted);
}
.timeline li::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 12px;
  width: 14px;
  height: 14px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid var(--muted);
  background: transparent;
}
.timeline li.done { color: var(--fg); }
.timeline li.done::before { background: var(--ok); border-color: var(--ok); }
.timeline li.current { color: var(--fg); font-weight: 700; }
.timeline li.current::before { background: var(--info); border-color: var(--info); }

.mail-item {
  border-bottom: 1px solid var(--line);
  padding: 10px 0;
}
.mail-item summary {
  cursor: pointer;
  list-style: none;
}
.mail-item summary::-webkit-details-marker { display: none; }
.mail-from { font-weight: 700; }
.mail-subject { margin-top: 2px; }
.mail-date { color: var(--muted); font-size: .8rem; }
.mail-body {
  white-space: pre-wrap;
  font-size: .95rem;
  margin: 8px 0;
}

.director-grid {
  display: grid;
  gap: 8px;
}
.scene h2 { margin-bottom: .25rem; }
.variants {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.variants .btn {
  flex: 1 1 140px;
  margin: 0;
}
.tag-avg,
.tag-bad {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: .7rem;
  font-weight: 700;
  letter-spacing: .06em;
  vertical-align: middle;
}
.tag-avg {
  background: rgba(21, 128, 61, .15);
  color: var(--ok);
}
.tag-bad {
  background: var(--bad);
  color: #fff;
}
.btn .tag-avg {
  background: rgba(255, 255, 255, .2);
  color: inherit;
}

details.caption {
  margin: 12px 16px 20px;
  background: var(--card);
  border-radius: 14px;
  padding: 10px 14px;
}
details.caption summary {
  display: flex;
  align-items: center;
  min-height: 44px;
  font-weight: 700;
  cursor: pointer;
  list-style: none;
}
details.caption summary::-webkit-details-marker { display: none; }
details.caption .codes { margin: 6px 0; }
details.caption ul {
  padding-left: 18px;
  margin: 6px 0 0;
}
details.caption li { margin: 4px 0; }

.hidden-text {
  color: #ffffff;
  font-size: 1px;
  line-height: 1px;
}
.reveal .hidden-text {
  display: block;
  margin-top: 8px;
  padding: 8px;
  color: var(--bad);
  font-size: .9rem;
  line-height: 1.4;
  background: rgba(185, 28, 28, .08);
  outline: 2px dashed var(--bad);
}

table.items {
  width: 100%;
  border-collapse: collapse;
}
table.items th,
table.items td {
  padding: 6px 4px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  font-size: .9rem;
  vertical-align: top;
}

.focus {
  outline: 3px solid var(--info);
  outline-offset: 2px;
  border-radius: 16px;
}

[hidden] { display: none !important; }
`;

export const STAGE_JS: string = `
(function () {
  "use strict";

  var LABELS_EN = { ok: "Done", bad: "Blocked", warn: "Warning", info: "Info" };
  var LABELS_ZH = { ok: "成功", bad: "已拦截", warn: "注意", info: "信息" };

  function labelFor(tone) {
    var zh = (document.documentElement.lang || "").indexOf("zh") === 0;
    var table = zh ? LABELS_ZH : LABELS_EN;
    return Object.prototype.hasOwnProperty.call(table, tone) ? table[tone] : String(tone);
  }

  var KEY_STORE = "kassa:stageKey";

  function storedKey() {
    try {
      return localStorage.getItem(KEY_STORE) || "";
    } catch (e) {
      return "";
    }
  }

  async function post(action, body, retried) {
    var res;
    var headers = { "content-type": "application/json" };
    var key = storedKey();
    if (key) headers["x-stage-key"] = key;
    try {
      res = await fetch("/mock/stage/api/" + action, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      return { ok: false, tone: "bad", title: "Network error", detail: String(e) };
    }
    // Reset and the shared clock need the operator's key: ask once, keep it in this browser, retry once.
    if (res.status === 401 && !retried) {
      var typed = window.prompt("Operator key (the demo admin token) for reset and the demo clock:");
      if (typed) {
        try {
          localStorage.setItem(KEY_STORE, typed.trim());
        } catch (e) {}
        return post(action, body, true);
      }
    }
    var j;
    try {
      j = await res.json();
    } catch (e) {
      return { ok: false, tone: "bad", title: "HTTP " + res.status, detail: "" };
    }
    if (!j || typeof j !== "object" || !("tone" in j)) {
      return {
        ok: false,
        tone: "bad",
        title: (j && j.error) || ("HTTP " + res.status),
        detail: (j && j.code) || ""
      };
    }
    return j;
  }

  async function state() {
    var res = await fetch("/mock/stage/api/state", { cache: "no-store" });
    return res.json();
  }

  function show(el, r) {
    if (!el) return;
    el.hidden = false;
    el.dataset.tone = r.tone;
    while (el.firstChild) el.removeChild(el.firstChild);

    var label = document.createElement("span");
    label.className = "status-label";
    label.textContent = labelFor(r.tone);

    var title = document.createElement("strong");
    title.className = "status-title";
    title.textContent = r.title || "";

    var detail = document.createElement("span");
    detail.className = "status-detail";
    detail.textContent = r.detail || "";

    el.appendChild(label);
    el.appendChild(title);
    el.appendChild(detail);
  }

  async function run(btn, action, body, out) {
    btn.disabled = true;
    var r;
    try {
      r = await post(action, body);
      show(out, r);
    } finally {
      btn.disabled = false;
    }
    return r;
  }

  function focusFromQuery() {
    var v = new URLSearchParams(location.search).get("v");
    if (!v) return;
    var el = document.getElementById(v);
    if (!el) return;
    el.classList.add("focus");
    el.scrollIntoView({ block: "start" });
  }

  function fmtTime(iso) {
    return iso ? new Date(iso).toLocaleString() : "";
  }

  document.addEventListener("DOMContentLoaded", focusFromQuery);

  window.stage = { post: post, state: state, show: show, run: run, fmtTime: fmtTime };
})();
`;
