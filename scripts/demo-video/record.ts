/*
 * Records the demo video (docs/DEMO_SCRIPT.md, five beats) as one continuous take of the real web app, with captions
 * on screen and a chapter list. Passkeys are real WebAuthn ceremonies against Chromium's virtual authenticator, so
 * nothing is faked: the same clicks a person makes. Everything shown is the demo's simulated data.
 *
 *   DEMO_ADMIN_TOKEN=… bun scripts/demo-video/record.ts [--app http://localhost:8081] [--api http://localhost:4000/api]
 *     [--out demo-video-out] [--chromium /path/to/chrome] [--no-reset]
 *
 * Beat 1 talks to the onboarding agent: with a model key (AGENT_MODE=LIVE) it is the live agent; without one the
 * server answers from the recorded replay, which does not know the uploaded statements yet (IMPORT_PLAN handoff).
 * Output: <out>/kassa-demo.webm, kassa-demo.mp4 (when ffmpeg is on PATH) and chapters.txt.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium, type Page } from "playwright";

import { demoStatements } from "./statements.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const APP = arg("app", "http://localhost:8081").replace(/\/$/, "");
const API = arg("api", "http://localhost:4000/api").replace(/\/$/, "");
const OUT = resolve(arg("out", "demo-video-out"));
const CHROMIUM = arg("chromium", process.env.CHROMIUM_PATH ?? "");
const TOKEN = process.env.DEMO_ADMIN_TOKEN ?? "";
const SIZE = { width: 430, height: 932 };

/** The onboarding conversation (the same lines the recorded replay knows). */
const ONBOARDING_LINES = [
  "Hi! I'm Dana, a Kazakh master's student in Budapest. My home currency is the tenge.",
  "My parents send ₸600,000 on the 25th of every month, and I get a $400 scholarship on the 1st.",
  "Rent is HUF 180,000 to my landlord Landlord in Budapest on the 1st. Tuition is €2,400 to University in Budapest, due October 31, and I pay Student Insurer in EU €96 per term, next on November 15.",
  "Budgets: groceries ₸90,000, eating out ₸60,000, transport ₸20,000 a month. Cards: home bank KZT card ending 4821, USD card 7310 and a local HUF/EUR card 0596. Use the Smart preset with the capped wallet, and notify me after each purchase.",
];

async function admin(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-kassa-demo-token": TOKEN }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const t0 = Date.now();
const chapters: string[] = [];
const stamp = () => {
  const s = Math.round((Date.now() - t0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** A caption band at the bottom of the screen (kept across reloads in sessionStorage). */
async function caption(page: Page, text: string, chapter?: string): Promise<void> {
  if (chapter) chapters.push(`${stamp()} ${chapter}`);
  await page.evaluate((t) => {
    sessionStorage.setItem("demo-caption", t);
    (window as unknown as { __caption?: (t: string) => void }).__caption?.(t);
  }, text);
}

const CAPTION_SCRIPT = () => {
  const show = (t: string) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.setAttribute("style", "position:fixed;left:12px;right:12px;bottom:18px;z-index:99999;pointer-events:none;background:rgba(18,32,43,0.92);color:#F4F1EA;font:600 15px/1.35 system-ui,sans-serif;padding:10px 14px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.25)");
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.display = t ? "block" : "none";
  };
  (window as unknown as { __caption: (t: string) => void }).__caption = show;
  document.addEventListener("DOMContentLoaded", () => show(sessionStorage.getItem("demo-caption") ?? ""));
};

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function scrollThrough(page: Page, steps: number, ms = 900): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, 380);
    await pause(page, ms);
  }
}

async function waitForAssistant(page: Page, before: number): Promise<void> {
  // A reply is in when the page text grows and the send button is idle again.
  for (let i = 0; i < 60; i++) {
    await pause(page, 1000);
    if ((await page.innerText("body")).length > before + 40) break;
  }
  await pause(page, 2500);
}

async function main(): Promise<void> {
  if (!TOKEN) throw new Error("DEMO_ADMIN_TOKEN is not set (the Stage controls need it)");
  mkdirSync(OUT, { recursive: true });
  const stmtDir = join(OUT, "statements");
  mkdirSync(stmtDir, { recursive: true });
  const files = demoStatements().map((f) => {
    const p = join(stmtDir, f.name);
    writeFileSync(p, f.text);
    return p;
  });
  if (!process.argv.includes("--no-reset")) {
    await admin("/demo/reset");
    await admin("/demo/clock/mode", { mode: "DEMO" });
  }

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE } });
  await ctx.addInitScript(CAPTION_SCRIPT);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  // Intro.
  await page.goto(`${APP}/`, { waitUntil: "load" });
  await pause(page, 4000);
  await caption(page, "Dana is a Kazakh student in Budapest: money in KZT and USD, bills in HUF and EUR.", "Intro");
  await pause(page, 4500);

  // Beat 1: the agent meets Dana and learns her bank history.
  await caption(page, "She opens Kassa and creates a passkey. The agent asks for her bank statements first.", "1. The agent learns her history");
  await page.getByText("Try the demo (simulated)").click();
  await page.waitForURL(/onboarding/, { timeout: 60_000 });
  await pause(page, 3000);
  await page.getByText("I agree", { exact: true }).click();
  await pause(page, 2000);
  const chooser = page.waitForEvent("filechooser");
  await page.getByLabel("Upload bank statements").click();
  await (await chooser).setFiles(files);
  await caption(page, "Two statements, read in code in seconds: periods, how regular money from home is, rent, one-offs, own transfers.");
  await pause(page, 6000);
  await scrollThrough(page, 4, 1400);
  await page.getByText("Use this history", { exact: true }).last().click();
  await pause(page, 8000);
  await caption(page, "The agent prefills her draft from the history. She fills in the rest in plain words.");
  for (const line of ONBOARDING_LINES) {
    const before = (await page.innerText("body")).length;
    await page.getByLabel("Message").first().fill(line);
    await page.getByLabel("Send").first().click();
    await waitForAssistant(page, before);
    if (await page.getByText("Review my setup", { exact: true }).isVisible()) break;
  }
  await page.getByText("Review my setup", { exact: true }).click();
  await pause(page, 3000);
  await caption(page, "She reviews the limits the agent drafted and signs them once with her passkey.");
  await scrollThrough(page, 3, 1200);
  await page.getByText("Sign rules with passkey", { exact: true }).click();
  await pause(page, 5000);
  const mandate = page.getByText("Sign mandate with passkey", { exact: true });
  if (await mandate.isVisible().catch(() => false)) {
    await caption(page, "The agent offers a rent mandate: rent to her verified landlord, up to a signed cap. She signs it.");
    await pause(page, 2500);
    await mandate.click();
    await pause(page, 5000);
  }
  await page.waitForURL(/home|\/$/, { timeout: 30_000 }).catch(() => undefined);
  // Kassa asks for backup codes before Home (the way back in if the phone is lost): create, confirm, continue.
  await pause(page, 3000);
  const create = page.getByText("Create backup codes", { exact: true });
  if (await create.isVisible().catch(() => false)) {
    await caption(page, "Before anything else, Kassa has her save backup codes: the way back in if she loses her phone.");
    await create.click();
    await pause(page, 4000);
    // The confirmation is a switch: its input is hidden, so press the visible track it sits in.
    const sw = page.getByRole("switch").last();
    if ((await sw.count()) > 0) {
      const box = await sw.evaluate((el) => {
        const r = el.parentElement!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
    }
    await pause(page, 1000);
    await page.getByText("I saved them", { exact: true }).click();
    await pause(page, 3000);
  }

  // Beat 2: Home.
  await page.goto(`${APP}/`, { waitUntil: "load" });
  await pause(page, 4000);
  await caption(page, "Home: what the agent did this week, what her bank history shows, budgets and bills.", "2. Home");
  await scrollThrough(page, 5, 1500);

  // Beat 3: rent day, inside the mandate.
  await caption(page, "Three days later it is rent day. The agent pays inside her signed mandate: no prompt.", "3. Rent day");
  await admin("/demo/clock/advance", { hours: 72 });
  await page.goto(`${APP}/`, { waitUntil: "load" });
  await pause(page, 5000);
  await scrollThrough(page, 2, 1500);
  await pause(page, 2500);

  // Beat 4: attacks.
  await caption(page, "Sixteen famous agent money hacks, recreated: the same agent without Kassa's guards pays all 16; with them, 0.", "4. Attacks fail");
  await page.goto(`${APP}/evidence`, { waitUntil: "load" });
  await pause(page, 5000);
  await scrollThrough(page, 8, 1300);

  // Beat 5: credit record.
  await caption(page, "A signed credit record of bills paid on time, for a landlord or bank abroad.", "5. Credit record");
  await page.goto(`${APP}/credit-record`, { waitUntil: "load" });
  await pause(page, 5000);
  await scrollThrough(page, 3, 1500);

  await caption(page, "The agent can prepare anything. Only her signature, now or in a mandate, moves her money.", "Close");
  await pause(page, 5000);

  const video = page.video();
  await ctx.close();
  await browser.close();
  const raw = video ? await video.path() : readdirSync(OUT).filter((f) => f.endsWith(".webm")).map((f) => join(OUT, f))[0];
  const webm = join(OUT, "kassa-demo.webm");
  if (raw) renameSync(raw, webm);
  writeFileSync(join(OUT, "chapters.txt"), chapters.join("\n") + "\n");
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", join(OUT, "kassa-demo.mp4")]);
  } catch {
    console.log("ffmpeg not found or failed: keeping the .webm only");
  }
  console.log(`done in ${stamp()}: ${OUT}`);
  console.log(chapters.join("\n"));
}

await main();
