/*
 * Shared frame for the Demo Stage phone screens (/mock/stage/*). Every page gets the "Simulated" ribbon, the app bar,
 * the screen body and the "What Kassa does" caption. `body` and `script` are trusted HTML/JS built in pages.ts; every
 * other value (title, app name, caption codes and points, language) is escaped here.
 */
import { esc } from "../html.ts";

export interface Caption {
  /** Invariant / attack codes, e.g. ["I6", "I13"]. Rendered as chips. */
  codes: string[];
  /** Plain-language bullet points for the judges. */
  points: string[];
}

export function stagePage(o: {
  title: string;
  appName: string;
  body: string;
  caption: Caption;
  lang?: "en" | "zh-CN";
  script?: string;
  back?: boolean;
}): string {
  const lang = o.lang ?? "en";
  const zh = lang === "zh-CN";
  const ribbon = zh ? "Simulated · 模拟" : "Simulated";
  const summary = zh ? "What Kassa does · Kassa 做了什么" : "What Kassa does";
  const back = o.back !== false ? '<a class="back" href="/mock/stage" aria-label="Back to Demo Stage">‹</a>' : "";
  const codes = o.caption.codes.map((c) => `<span class="chip">${esc(c)}</span>`).join(" ");
  const points = o.caption.points.map((p) => `<li>${esc(p)}</li>`).join("\n");
  const script = o.script ? `<script>window.addEventListener("DOMContentLoaded", () => {\n${o.script}\n});</script>` : "";

  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(o.title)} (simulated)</title>
<link rel="stylesheet" href="/mock/stage/stage.css">
<script src="/mock/stage/stage.js" defer></script>
</head>
<body class="stage">
<div class="device">
<div class="ribbon" role="note">${ribbon}</div>
<header class="appbar">${back}<span class="appname">${esc(o.appName)}</span></header>
<main class="screen">${o.body}</main>
<details class="caption"><summary>${summary}</summary><p class="codes">${codes}</p><ul>${points}</ul></details>
</div>
${script}
</body>
</html>
`;
}
