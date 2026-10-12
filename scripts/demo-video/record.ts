#!/usr/bin/env bun
/**
 * `bun run demo:video` - record the EU and China demo stories as videos (docs/demo/kassa-eu.mp4, kassa-cn.mp4,
 * kassa-demo.mp4; gitignored).
 *
 * 1. Exports the mobile web app (`expo export -p web`) into .data/demo-video/web for the single origin
 *    http://localhost:8090 (skip with --skip-export when the export is current).
 * 2. Starts a fresh sim (apps/api/scripts/sim: api + mock-world, DEMO_ENABLED, ISSUING_PROVIDER=fake, REPLAY agent,
 *    SHOP_AUTOPILOT=false) with PUBLIC_ORIGIN = that origin, and `scripts/phone.ts --no-tunnel` on :8090 in front of
 *    it, so the app, /api and /mock share one origin and the passkey RP ID is localhost.
 * 3. Registers the personas over the API with software passkeys (like `sim story`), signs the browser in with a web
 *    session cookie, and imports the persona's passkey into a CDP virtual authenticator: "Approve with passkey" and
 *    "Sign with passkey" run the app's real WebAuthn flow. If a UI step fails, the beat falls back to the API
 *    (soft passkey) and the run log says so.
 * 4. Records three Playwright contexts per story (app 390x844, world page 988x632, caption strip 1280x88) and calls
 *    compose.sh to stack them into 1280x720 H.264 with a title card.
 *
 * Everything it starts (sim daemon, proxy, browser) is stopped in `finally` and on SIGINT/SIGTERM.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright";

import type { PersonaFile } from "../../apps/api/scripts/sim/lib/persona.ts";

const ROOT = join(import.meta.dir, "../..");
const WORK = join(ROOT, ".data/demo-video");
const WEB_DIST = join(WORK, "web");
const OUT = join(ROOT, "docs/demo");
const PORT = 8090;
const APP = `http://localhost:${PORT}`;

// The sim daemon copies process.env: set the single-origin values before `up()`.
Object.assign(process.env, {
  PUBLIC_ORIGIN: APP,
  RP_ID: "localhost",
  KASSA_APP_URL: APP,
  ISSUING_PROVIDER: "fake",
  SHOP_AUTOPILOT: "false",
});
delete process.env.EXTRA_ORIGINS;

const { approve, demo, mockGet, mockPost, onboard, orderView, result, settleWebhooks } = await import("../../apps/api/scripts/sim/lib/commands.ts");
const { control, apiRequestRaw } = await import("../../apps/api/scripts/sim/lib/http.ts");
const { down, up, portBusy } = await import("../../apps/api/scripts/sim/lib/lifecycle.ts");
const { assertWith, authenticatorOf, personaRequest, registerPersona, savePersona } = await import("../../apps/api/scripts/sim/lib/persona.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[demo-video]", ...a);
const b64 = (b64url: string) => Buffer.from(b64url, "base64url").toString("base64");

type BeatLog = { story: string; beat: string; mode: "ui" | "api" | "auto" | "mixed" | "failed"; notes: string[] };
const runLog: BeatLog[] = [];

async function until<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function get<T>(p: PersonaFile, path: string): Promise<T> {
  return result(await personaRequest(p, "GET", path), `GET ${path}`).data as T;
}

// ---------------------------------------------------------------- processes

let proxy: ChildProcess | null = null;
let browser: Browser | null = null;
let simUp = false;

async function cleanup() {
  await browser?.close().catch(() => undefined);
  browser = null;
  if (proxy && proxy.exitCode === null) proxy.kill("SIGTERM");
  proxy = null;
  if (simUp) await down().catch((e: Error) => log("sim down failed:", e.message));
  simUp = false;
}

function exportWeb() {
  if (process.argv.includes("--skip-export") && existsSync(join(WEB_DIST, "index.html"))) return;
  log("exporting the web app...");
  rmSync(WEB_DIST, { recursive: true, force: true });
  const r = spawnSync("bunx", ["expo", "export", "-p", "web", "-c", "--output-dir", WEB_DIST], {
    cwd: join(ROOT, "apps/mobile"),
    env: { ...process.env, CI: "1", EXPO_PUBLIC_API_URL: APP, EXPO_PUBLIC_DEMO_ADMIN_TOKEN: "not-available-in-web-build" },
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 600_000,
  });
  if (!existsSync(join(WEB_DIST, "index.html"))) throw new Error(`expo export failed (exit ${r.status})`);
}

async function startProxy() {
  if (await portBusy(PORT)) throw new Error(`port ${PORT} is in use`);
  proxy = spawn(process.execPath, [join(ROOT, "scripts/phone.ts"), "--no-tunnel"], {
    cwd: ROOT,
    env: { ...process.env, PHONE_PORT: String(PORT), PHONE_DIST: WEB_DIST },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await until(async () => (await fetch(`${APP}/mock/health`)).ok, "the proxy", 15_000);
}

// ---------------------------------------------------------------- personas

async function persona(name: string, claim: true | string, noMandate: boolean): Promise<PersonaFile> {
  const { persona: p, session } = await registerPersona(name, { claimDemo: claim, force: true, aiConsent: true });
  if (!session.onboarded) await onboard(p, { noMandate });
  return p;
}

/** A web session cookie for `p` (passkey sign-in with client "web", signed by the persona's soft passkey). */
async function webCookie(p: PersonaFile): Promise<string> {
  const headers = { "x-forwarded-for": p.clientIp, origin: APP };
  const o = await apiRequestRaw("POST", "/auth/login/options", { headers });
  const ob = o.body as { challengeId: string; options: { challenge: string; rpId?: string } };
  const auth = authenticatorOf(p);
  const response = assertWith(auth, ob.options.challenge, { rpId: ob.options.rpId ?? "localhost" });
  p.credential = auth.export();
  savePersona(p);
  const v = await apiRequestRaw("POST", "/auth/login/verify", { body: { challengeId: ob.challengeId, response, client: "web" }, headers });
  const m = /kassa_session=([^;]+)/.exec(v.headers.get("set-cookie") ?? "");
  if (v.status !== 200 || !m) throw new Error(`web login for ${p.name} failed (HTTP ${v.status})`);
  return m[1]!;
}

// ---------------------------------------------------------------- recording

type Pane = { ctx: BrowserContext; page: Page; startedAt: number };

async function pane(dir: string, width: number, height: number): Promise<Pane> {
  const ctx = await browser!.newContext({ viewport: { width, height }, deviceScaleFactor: 1, recordVideo: { dir, size: { width, height } } });
  // Playwright's action timeout is infinite by default: a missing element must fail the beat, not hang the run.
  ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage();
  return { ctx, page, startedAt: Date.now() };
}

const CAPTION_HTML = `<!doctype html><html><body style="margin:0;background:#0b1220;color:#f8fafc;font:600 25px -apple-system,Helvetica,Arial,sans-serif;height:88px;display:flex;align-items:center;padding:0 28px;box-sizing:border-box">
<div id="tag" style="background:#2563eb;border-radius:8px;padding:6px 12px;margin-right:18px;font-size:19px;white-space:nowrap"></div><div id="cap" style="line-height:1.25"></div></body></html>`;

function titleHtml(title: string, sub: string) {
  return `<!doctype html><html><body style="margin:0;width:1280px;height:720px;background:linear-gradient(135deg,#0b1220,#1e3a8a);color:#fff;font-family:-apple-system,Helvetica,Arial,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center">
<div style="font-size:30px;letter-spacing:6px;opacity:.7">KASSA</div><div style="font-size:60px;font-weight:700;margin:18px 0">${title}</div><div style="font-size:26px;opacity:.85">${sub}</div></body></html>`;
}

class Story {
  app!: Pane;
  world!: Pane;
  cap!: Pane;
  cdp!: CDPSession;
  authenticatorId = "";
  current: PersonaFile | null = null;
  readonly dir: string;
  constructor(readonly key: string) {
    this.dir = join(WORK, key);
  }

  async open() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    // Open all three at once so the recordings start together; compose.sh trims each by its offset.
    [this.app, this.world, this.cap] = await Promise.all([pane(join(this.dir, "app"), 390, 844), pane(join(this.dir, "world"), 988, 632), pane(join(this.dir, "cap"), 1280, 88)]);
    await this.cap.page.setContent(CAPTION_HTML);
    await this.world.page.setContent(`<body style="margin:0;background:#f1f5f9"></body>`);
    this.cdp = await this.app.ctx.newCDPSession(this.app.page);
    await this.cdp.send("WebAuthn.enable");
    const r = await this.cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    this.authenticatorId = r.authenticatorId;
  }

  /** Sign the app in as `p`: web session cookie + p's passkey in the virtual authenticator. */
  async use(p: PersonaFile, path: string) {
    this.current = p;
    await this.app.ctx.clearCookies();
    await this.app.ctx.addCookies([{ name: "kassa_session", value: await webCookie(p), domain: "localhost", path: "/api", httpOnly: true, sameSite: "Lax" }]);
    await this.loadCredential(p);
    await this.go(path);
  }

  private async loadCredential(p: PersonaFile) {
    await this.cdp.send("WebAuthn.clearCredentials", { authenticatorId: this.authenticatorId });
    await this.cdp.send("WebAuthn.addCredential", {
      authenticatorId: this.authenticatorId,
      credential: {
        credentialId: b64(p.credential.credentialId),
        isResidentCredential: true,
        rpId: "localhost",
        privateKey: b64(p.credential.privateKeyPkcs8),
        userHandle: Buffer.from(p.userId).toString("base64"),
        signCount: p.credential.counter,
      },
    });
  }

  /** Run a UI passkey step; keep the soft passkey's counter ahead of the virtual authenticator's (no regression). */
  async passkey(action: () => Promise<void>) {
    const p = this.current!;
    await this.loadCredential(p);
    const count = async () => {
      const { credentials } = await this.cdp.send("WebAuthn.getCredentials", { authenticatorId: this.authenticatorId });
      return credentials[0]?.signCount ?? 0;
    };
    const start = await count();
    try {
      await action();
    } finally {
      // The click returns before the app's WebAuthn call runs: wait for the assertion to bump the counter.
      const used = await until(async () => {
        const c = await count();
        return c > start ? c : null;
      }, "the passkey assertion", 15_000).catch(() => start);
      if (used > p.credential.counter) {
        p.credential.counter = used;
        savePersona(p);
      }
    }
  }

  async go(path: string) {
    await this.app.page.goto(`${APP}${path}`, { waitUntil: "networkidle" }).catch(() => undefined);
  }

  async world_(path: string) {
    await this.world.page.goto(`${APP}${path}`, { waitUntil: "networkidle" }).catch(() => undefined);
  }

  async caption(tag: string, text: string) {
    log(`${this.key} ${tag}: ${text}`);
    await this.cap.page.evaluate(([t, c]) => {
      document.getElementById("tag")!.textContent = t!;
      document.getElementById("cap")!.textContent = c!;
    }, [tag, text]);
  }

  /** An iOS-style banner over the app pane (the phone's notification for a capture nudge). */
  async notify(title: string, body: string) {
    await this.app.page.evaluate(
      ([t, b]) => {
        const d = document.createElement("div");
        d.id = "demo-notify";
        d.style.cssText =
          "position:fixed;left:10px;right:10px;top:-140px;z-index:99999;background:rgba(245,245,247,.97);color:#111;border-radius:18px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.25);font:14px -apple-system,Helvetica,Arial,sans-serif;transition:top .45s";
        d.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><div style="width:20px;height:20px;border-radius:5px;background:#2563eb"></div><b style="flex:1">KASSA</b><span style="opacity:.6">now</span></div>';
        const tt = document.createElement("div");
        tt.style.fontWeight = "600";
        tt.textContent = t!;
        const bb = document.createElement("div");
        bb.textContent = b!;
        d.append(tt, bb);
        document.body.append(d);
        requestAnimationFrame(() => requestAnimationFrame(() => (d.style.top = "10px")));
      },
      [title, body],
    );
  }

  async beat(beat: string, fn: (notes: string[]) => Promise<"ui" | "api" | "auto" | "mixed">) {
    const notes: string[] = [];
    try {
      runLog.push({ story: this.key, beat, mode: await fn(notes), notes });
    } catch (e) {
      notes.push((e as Error).message.split("\n")[0]!);
      log(`beat ${beat} failed: ${(e as Error).message}`);
      await this.app.page.screenshot({ path: join(WORK, `fail-${this.key}-${beat}-app.png`) }).catch(() => undefined);
      await this.world.page.screenshot({ path: join(WORK, `fail-${this.key}-${beat}-world.png`) }).catch(() => undefined);
      runLog.push({ story: this.key, beat, mode: "failed", notes });
    }
  }

  /** Close the recordings; returns compose.sh arguments for this story. */
  async close(): Promise<{ app: string; world: string; cap: string; offsets: [number, number, number]; seconds: number }> {
    const end = Date.now();
    const t0 = Math.max(this.app.startedAt, this.world.startedAt, this.cap.startedAt);
    const files = [this.app, this.world, this.cap].map((p) => p.page.video()!);
    await Promise.all([this.app.ctx.close(), this.world.ctx.close(), this.cap.ctx.close()]);
    const paths = await Promise.all(files.map((v) => v.path()));
    const off = (p: Pane) => (t0 - p.startedAt) / 1000;
    return { app: paths[0]!, world: paths[1]!, cap: paths[2]!, offsets: [off(this.app), off(this.world), off(this.cap)], seconds: (end - t0) / 1000 };
  }
}

const hold = (ms: number) => sleep(ms);

async function orderStatus(p: PersonaFile, proposalId: string): Promise<string> {
  return ((await orderView(p, proposalId)).data as unknown as { status: string }).status;
}

type Approval = { mode: "ui" | "api" | "auto"; paymentId: string | null };

/**
 * Click "Approve with passkey" on /order/<id>; fall back to the API (soft passkey) if the UI did not approve.
 * "auto": nothing to approve (the persona's signed rules executed it already).
 */
async function approveInApp(s: Story, proposalId: string, notes: string[]): Promise<Approval> {
  const p = s.current!;
  if (!s.app.page.url().includes(`/order/${proposalId}`)) await s.go(`/order/${proposalId}`);
  const btn = s.app.page.getByText("Approve with passkey").first();
  const before = await orderStatus(p, proposalId);
  if (before !== "PENDING_APPROVAL") {
    notes.push(`no approval needed (${before})`);
    return { mode: "auto", paymentId: null };
  }
  try {
    await btn.waitFor({ timeout: 15_000 });
    await hold(2500);
    const resp = s.app.page.waitForResponse((r) => r.url().includes(`/api/orders/${proposalId}/approve`), { timeout: 20_000 });
    await s.passkey(() => btn.click());
    const r = await resp;
    const body = (await r.json().catch(() => null)) as { paymentId?: string | null } | null;
    if (r.status() !== 200 || !body?.paymentId) notes.push(`approve HTTP ${r.status()}: ${JSON.stringify(body).slice(0, 300)}`);
    await until(async () => await orderStatus(p, proposalId) !== "PENDING_APPROVAL", "the UI approval", 15_000);
    return { mode: "ui", paymentId: body?.paymentId ?? null };
  } catch (e) {
    notes.push(`UI approve fell back to API: ${(e as Error).message.split("\n")[0]}`);
    const a = (await orderStatus(p, proposalId)) === "PENDING_APPROVAL" ? ((await approve(p, proposalId)) as { data: { paymentId: string | null } }) : null;
    return { mode: "api", paymentId: a?.data.paymentId ?? null };
  }
}

/** The app's QR handoff screen for `paymentId` (the sheet navigates there itself for HANDOFF orders). */
async function toHandoff(s: Story, a: Approval): Promise<boolean> {
  if (await s.app.page.waitForURL(/\/handoff\//, { timeout: 8_000 }).then(() => true, () => false)) return true;
  if (!a.paymentId) return false;
  await s.go(`/handoff/${a.paymentId}`);
  return true;
}

async function chatInApp(s: Story, text: string) {
  const page = s.app.page;
  const input = page.getByPlaceholder("Ask Kassa");
  await input.waitFor({ timeout: 15_000 });
  await input.click();
  await input.pressSequentially(text, { delay: 45 });
  await hold(600);
  await page.getByRole("button", { name: "Send" }).click();
  // The turn streams; the button reads "Stop" until it ends (the response body never "finishes" for Playwright).
  await page.getByRole("button", { name: "Stop" }).waitFor({ timeout: 5_000 }).catch(() => undefined);
  await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 60_000 });
  await hold(3500);
}

/** Pay the latest QR in the mock super-app wallet (world pane). */
async function walletPay(s: Story) {
  await s.world_("/mock/stage/wallet");
  await hold(2500);
  await s.world.page.locator("#pay").click();
  await hold(3000);
}

/** The business Orders tab (a deep link to /orders lands on Today: switch tabs like the owner would). */
async function goOrders(s: Story) {
  const page = s.app.page;
  if (!new URL(page.url()).pathname.startsWith("/today")) await s.go("/today");
  await page.getByText("Orders", { exact: true }).last().click();
  await page.waitForURL(/\/orders/, { timeout: 10_000 }).catch(() => undefined);
  await hold(1200);
}

/** The business Orders tab lists POs collapsed: open the details (reasons, timeline, sign / pay) of PO `poId`. */
async function openPoDetails(s: Story, poId: string) {
  const page = s.app.page;
  const detail = page.locator(`[data-testid="po-detail-${poId}"]`);
  await page.getByText("Details", { exact: true }).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  const buttons = page.getByText("Details", { exact: true });
  const n = await buttons.count();
  for (let i = 0; i < n && !(await detail.isVisible()); i++) {
    await buttons.nth(i).click();
    await hold(300);
  }
  await detail.scrollIntoViewIfNeeded().catch(() => undefined);
  await hold(800);
}

type Po = { id: string; status: string; reasonCodes: string[]; proposalId?: string | null };

// ---------------------------------------------------------------- stories

async function eu(dana: PersonaFile) {
  const s = new Story("eu");
  await s.open();
  await s.caption("EU", "Dana, a student in Budapest. Her Kassa app (left) and the world around her (right).");
  await s.use(dana, "/home");
  await s.world_("/mock/stage/tap");
  await hold(3500);

  await s.beat("cafe-tap", async (notes) => {
    await s.caption("1/4 Café", "Dana taps her card at a café. Her iOS Shortcut sends the purchase to Kassa.");
    await hold(2500);
    const resp = s.world.page.waitForResponse((r) => r.url().includes("/stage/api/tap-coffee"), { timeout: 20_000 });
    await s.world.page.locator("#tapCoffee").click();
    const body = (await (await resp).json()) as { detail?: string; data?: { nudge?: string; notification?: { en?: { title?: string; body?: string } } } };
    const n = body.data?.notification?.en;
    const nudge = body.data?.nudge ?? n?.body ?? body.detail ?? "Logged.";
    notes.push(`nudge: ${nudge}`);
    await hold(1500);
    await s.notify(n?.title ?? "Coffee logged", nudge);
    await s.caption("1/4 Café", "Kassa logs it and nudges her budget. Capture only logs: it never pays.");
    await hold(5000);
    await s.go("/activity");
    await s.caption("1/4 Café", "The spend shows up in Activity.");
    await hold(4500);
    return "ui";
  });

  await s.beat("pizza", async (notes) => {
    await s.world_("/mock/shop/bud/kitchen");
    await s.go("/chat");
    await s.caption("2/4 Chat", "Dana asks: “Order me 2 pizzas”. The AI can only draft an order.");
    await hold(2000);
    const before = (await get<{ proposals: { proposalId: string }[] }>(dana, "/proposals?limit=5")).proposals.map((x) => x.proposalId);
    await chatInApp(s, "Order me 2 pizzas");
    const prop = await until(async () => (await get<{ proposals: { proposalId: string }[] }>(dana, "/proposals?limit=5")).proposals.find((x) => !before.includes(x.proposalId)), "the pizza proposal");
    await hold(2000);
    await s.caption("2/4 Chat", "Rules check the draft; Dana approves the exact order with her passkey.");
    const { mode } = await approveInApp(s, prop.proposalId, notes);
    if (mode === "auto") await s.caption("2/4 Chat", "It fits the rules Dana signed with her passkey, so Kassa executes it: no prompt.");
    await hold(3000);
    const order = await until(async () => (await get<{ shopOrders: { id: string; externalOrderId: string | null }[] }>(dana, `/shop-orders?proposalId=${prop.proposalId}`)).shopOrders[0], "the shop order");
    await s.caption("2/4 Kitchen", "The pizzeria's kitchen screen gets the order, paid with a one-time card.");
    await s.world.page.reload({ waitUntil: "networkidle" }).catch(() => undefined);
    await hold(3000);
    let clicks = 0;
    for (let i = 0; i < 4; i++) {
      const b = s.world.page.getByRole("button", { name: /^Mark / }).first();
      try {
        await b.waitFor({ timeout: 8000 });
        await b.click();
        clicks++;
      } catch {
        await mockPost(`/shop/bud/orders/${encodeURIComponent(order.externalOrderId!)}/advance`, {});
      }
      await hold(1800);
    }
    await settleWebhooks();
    await s.caption("2/4 Kitchen", "Accepted, cooking, out for delivery, delivered: each step flows back to Dana's app.");
    await until(async () => (await get<{ status: string }>(dana, `/shop-orders/${order.id}`)).status === "DELIVERED", "DELIVERED");
    await s.go(`/order/${prop.proposalId}`);
    await hold(5000);
    if (clicks < 4) notes.push(`kitchen advanced via API ${4 - clicks}x`);
    return mode !== "api" && clicks === 4 ? "ui" : "mixed";
  });

  await s.beat("till", async (notes) => {
    await s.world_("/mock/shop/bud/till");
    await s.caption("3/4 Till", "At the counter the cashier rings up a bill and shows its QR code.");
    await hold(2000);
    const w = s.world.page;
    for (const sku of ["PZ-PEPP", "DR-COLA", "DR-COLA"]) {
      await w.locator(`button.item[data-sku="${sku}"]`).click();
      await hold(700);
    }
    await w.locator("#create").click();
    const link = w.locator("#link");
    await until(async () => ((await link.textContent()) ?? "").includes("/pay/"), "the till bill");
    const payUrl = new URL((await link.textContent())!.trim());
    const billId = payUrl.pathname.split("/").pop()!;
    await hold(2500);
    await s.caption("3/4 Till", "Dana scans it: only the bill id reaches Kassa; amount and shop come from the till.");
    await s.go(payUrl.pathname);
    const review = s.app.page.getByText("Review and pay").first();
    await review.waitFor({ timeout: 15_000 });
    await hold(3000);
    await review.click();
    await s.app.page.waitForURL(/\/order\//, { timeout: 15_000 });
    const proposalId = s.app.page.url().split("/order/")[1]!.split(/[?#]/)[0]!;
    await s.caption("3/4 Till", "Kassa checks the bill against Dana's signed rules...");
    const { mode } = await approveInApp(s, proposalId, notes);
    await settleWebhooks();
    await until(async () => ((await mockGet(`/shop/bud/bills/${billId}`)).data as { bill: { status: string } }).bill.status === "PAID", "the till PAID");
    await s.caption("3/4 Till", "...and the till turns green: PAID.");
    await hold(5000);
    return mode;
  });

  await s.beat("ledger", async () => {
    const r = await control<{ ok: boolean; [k: string]: unknown }>("/ledger-verify");
    await s.world.page.setContent(
      `<body style="margin:0;background:#0b1220;color:#e2e8f0;font:18px Menlo,monospace;padding:40px"><div style="font:700 34px -apple-system,Helvetica;color:${r.ok ? "#4ade80" : "#f87171"};margin-bottom:20px">ledger.verify(): ${r.ok ? "OK" : "FAILED"}</div><pre style="white-space:pre-wrap">${JSON.stringify(r, null, 2).replace(/[<>&]/g, "")}</pre></body>`,
    );
    await s.go("/activity");
    await s.caption("4/4 Ledger", "Every money movement is in a hash-chained, append-only ledger. Verified end to end.");
    await hold(6000);
    return "api";
  });
  return s.close();
}

async function cn(liwei: PersonaFile | null, sha: PersonaFile) {
  const s = new Story("cn");
  await s.open();
  await s.caption("CN", "Shanghai: a customer, a pizzeria owner and two suppliers. Kassa app (left), the world (right).");
  await hold(2000);

  if (liwei) {
    await s.beat("liwei-qr", async (notes) => {
      await s.use(liwei, "/home");
      await s.world_("/mock/shop/sha/till");
      await s.caption("1/5 Customer", "Li Wei buys pizza at the Shanghai shop's till.");
      await hold(2000);
      const w = s.world.page;
      for (const sku of ["PZ-MARG", "DR-COLA"]) {
        await w.locator(`button.item[data-sku="${sku}"]`).click();
        await hold(700);
      }
      await w.locator("#create").click();
      const link = w.locator("#link");
      await until(async () => ((await link.textContent()) ?? "").includes("/pay/"), "the sha till bill");
      const payUrl = new URL((await link.textContent())!.trim());
      const billId = payUrl.pathname.split("/").pop()!;
      await hold(2500);
      await s.go(payUrl.pathname);
      const review = s.app.page.getByText("Review and pay").first();
      await review.waitFor({ timeout: 15_000 });
      await hold(2500);
      await review.click();
      await s.app.page.waitForURL(/\/order\//, { timeout: 15_000 });
      const proposalId = s.app.page.url().split("/order/")[1]!.split(/[?#]/)[0]!;
      await s.caption("1/5 Customer", "He approves with his passkey; Kassa hands off to his wallet with a verified QR.");
      const ap = await approveInApp(s, proposalId, notes);
      const mode = ap.mode;
      const handoff = await toHandoff(s, ap);
      await hold(4000);
      if (handoff) {
        await s.caption("1/5 Customer", "He pays in the super-app wallet; the till sees the payment.");
        await walletPay(s);
      } else notes.push("no QR handoff (paid by card rail)");
      await settleWebhooks();
      await until(async () => ((await mockGet(`/shop/sha/bills/${billId}`)).data as { bill: { status: string } }).bill.status === "PAID", "the sha till PAID").catch((e: Error) => notes.push(e.message));
      await s.go(`/order/${proposalId}`);
      await hold(4000);
      return mode;
    });
  }

  let poId: string | null = null;
  await s.beat("forecast-draft", async () => {
    result(await personaRequest(sha, "POST", "/privacy/pipl-consent", { body: { consent: true } }), "pipl consent");
    await s.use(sha, "/today");
    await s.world_("/mock/supplier/c/portal");
    await s.caption("2/5 Owner", "The Shanghai owner's Today tab: the forecast says boxes run short by tomorrow.");
    await hold(6000);
    await s.go("/chat");
    await s.caption("2/5 Owner", "She asks the agent. It drafts a purchase order: drafting is all the AI can do.");
    await chatInApp(s, "Will we run out of anything tomorrow?");
    await chatInApp(s, "Order boxes from the usual supplier");
    const draft = await until(async () => (await get<{ items: Po[] }>(sha, "/business/purchase-orders")).items.find((x) => x.status === "DRAFT"), "the draft PO");
    poId = draft.id;
    await hold(2500);
    return "ui";
  });

  await s.beat("sign-confirm", async (notes) => {
    if (!poId) throw new Error("no draft PO");
    await goOrders(s);
    await s.caption("3/5 Sign", "She reviews the draft and signs the PO with her passkey; it goes to supplier C.");
    await openPoDetails(s, poId);
    const btn = s.app.page.getByText("Sign with passkey").first();
    let mode: "ui" | "api" = "ui";
    try {
      await btn.waitFor({ timeout: 15_000 });
      await hold(3000);
      await s.passkey(() => btn.click());
      await until(async () => ["SENT", "SIGNED"].includes((await get<Po>(sha, `/business/purchase-orders/${poId}`)).status), "the UI PO signature", 15_000);
    } catch (e) {
      notes.push(`UI sign fell back to API: ${(e as Error).message.split("\n")[0]}`);
      await s.app.page.screenshot({ path: join(WORK, "fallback-sign.png") }).catch(() => undefined);
      mode = "api";
      const o = result(await personaRequest(sha, "POST", `/business/purchase-orders/${poId}/sign/options`, { body: {} }), "sign options").data as { core: unknown; poHash: string; webauthnOptions: { rpId?: string } };
      const auth = authenticatorOf(sha);
      const assertion = assertWith(auth, o.poHash, { rpId: o.webauthnOptions.rpId ?? "localhost" });
      sha.credential = auth.export();
      savePersona(sha);
      result(await personaRequest(sha, "POST", `/business/purchase-orders/${poId}/sign`, { body: { core: o.core, assertion } }), "sign");
    }
    await settleWebhooks();
    await hold(2500);
    await s.world.page.reload({ waitUntil: "networkidle" }).catch(() => undefined);
    await s.caption("3/5 Supplier C", "Supplier C's portal receives the signed order and confirms it.");
    await hold(2500);
    const confirm = s.world.page.getByRole("button", { name: "Confirm" }).first();
    await confirm.waitFor({ timeout: 10_000 });
    await confirm.click();
    await settleWebhooks();
    await until(async () => (await get<Po>(sha, `/business/purchase-orders/${poId}`)).status === "CONFIRMED", "CONFIRMED");
    await goOrders(s);
    await openPoDetails(s, poId);
    await hold(4000);
    return mode;
  });

  await s.beat("swapped-invoice", async () => {
    if (!poId) throw new Error("no PO");
    await s.world_("/mock/supplier/d/portal");
    await s.caption("4/5 Attack", "Supplier D invoices C's order with its own bank details...");
    await hold(3000);
    const b = s.world.page.getByRole("button", { name: "Send invoice with swapped bank details" }).first();
    await b.waitFor({ timeout: 10_000 });
    await b.click();
    await settleWebhooks();
    await until(async () => (await get<Po>(sha, `/business/purchase-orders/${poId}`)).reasonCodes.includes("INVOICE_ACCOUNT_MISMATCH"), "the refusal");
    await hold(1500);
    await goOrders(s);
    await openPoDetails(s, poId);
    await s.caption("4/5 Attack", "...and Kassa refuses it: INVOICE_ACCOUNT_MISMATCH. Nothing to approve, nothing paid.");
    await hold(7000);
    return "ui";
  });

  await s.beat("invoice-paid", async (notes) => {
    if (!poId) throw new Error("no PO");
    await s.world_("/mock/supplier/c/portal");
    await s.caption("5/5 Invoice", "Supplier C delivers and invoices. Kassa matches PO, delivery and invoice.");
    await hold(2500);
    for (const name of ["Mark delivered", "Issue invoice"]) {
      const b = s.world.page.getByRole("button", { name }).first();
      await b.waitFor({ timeout: 10_000 });
      await b.click();
      await settleWebhooks();
      await hold(2500);
    }
    const po = await until(async () => {
      const x = await get<Po>(sha, `/business/purchase-orders/${poId}`);
      return x.status === "INVOICED" && x.proposalId ? x : null;
    }, "INVOICED");
    await goOrders(s);
    await hold(3000);
    await s.caption("5/5 Pay", "The owner approves the payment with her passkey and pays supplier C by verified QR.");
    const ap = await approveInApp(s, po.proposalId!, notes);
    const mode = ap.mode;
    const handoff = await toHandoff(s, ap);
    await hold(4000);
    if (handoff) await walletPay(s);
    else notes.push("no handoff screen after approve");
    await settleWebhooks();
    await until(async () => (await get<Po>(sha, `/business/purchase-orders/${poId}`)).status === "PAID", "PO PAID");
    await goOrders(s);
    await openPoDetails(s, poId);
    await s.caption("5/5 Paid", "The purchase order shows PAID. AI drafted; only the owner's passkey moved money.");
    await hold(6000);
    return mode;
  });
  return s.close();
}

// ---------------------------------------------------------------- main

async function titleCard(file: string, title: string, sub: string) {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.setContent(titleHtml(title, sub));
  await page.screenshot({ path: file });
  await ctx.close();
}

function compose(args: string[]) {
  const r = spawnSync("bash", [join(import.meta.dir, "compose.sh"), ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`compose.sh ${args[0]} failed (exit ${r.status})`);
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  exportWeb();
  const started = await up({ fresh: true, scheduler: false, liveFx: false });
  simUp = true;
  if (!(started as { started?: boolean }).started) throw new Error("sim did not start fresh");
  await demo("POST", "/demo/agent-mode", { mode: "REPLAY" });
  await startProxy();

  const dana = await persona("dana", true, false);
  await persona("owner-bud", "pizzeria-bud", true);
  const sha = await persona("owner-sha", "pizzeria-sha", true);
  const liwei = await persona("li-wei-cn", "li-wei-cn", true).catch((e: Error) => {
    log("li-wei-cn registration failed:", e.message);
    return null;
  });

  browser = await chromium.launch();
  await titleCard(join(WORK, "title-eu.png"), "EU: a student in Budapest", "Café nudge · chat order · till QR · verified ledger");
  await titleCard(join(WORK, "title-cn.png"), "China: a Shanghai pizzeria", "QR wallet · AI-drafted PO · supplier portal · swapped-invoice attack");
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const recs: ["eu" | "cn", Awaited<ReturnType<Story["close"]>>][] = [];
  if (only !== "cn") recs.push(["eu", await eu(dana)]);
  if (only !== "eu") recs.push(["cn", await cn(liwei, sha)]);
  await browser.close();
  browser = null;

  for (const [key, rec] of recs) {
    compose(["story", join(OUT, `kassa-${key}.mp4`), join(WORK, `title-${key}.png`), rec.app, String(rec.offsets[0]), rec.world, String(rec.offsets[1]), rec.cap, String(rec.offsets[2]), String(rec.seconds)]);
  }
  if (!only) compose(["join", join(OUT, "kassa-demo.mp4"), join(OUT, "kassa-eu.mp4"), join(OUT, "kassa-cn.mp4")]);
  writeFileSync(join(WORK, "run.json"), JSON.stringify(runLog, null, 2));
  for (const b of runLog) log(`${b.story}/${b.beat}: ${b.mode}${b.notes.length ? ` (${b.notes.join("; ")})` : ""}`);
  return runLog.every((b) => b.mode !== "failed");
}

const onSignal = (sig: NodeJS.Signals) => {
  void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

let ok = false;
try {
  ok = await main();
} catch (e) {
  log("failed:", (e as Error).stack ?? String(e));
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
