/*
 * Demo Stage screens (/mock/stage/*): the phone-sized "outside world" pages the presenter opens on a second screen.
 * Each page is server-rendered HTML with a small inline script that calls window.stage (stage.js) and therefore only
 * the JSON API under /mock/stage/api. Dynamic values are escaped with esc(); the scripts put API text in with
 * textContent only.
 */
import { esc } from "../html.ts";
import { stagePage } from "./layout.ts";

export interface StageEmail {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  attachments: { name: string; url: string }[];
}

export interface StageSupplier {
  name: string;
  city: string;
  items: { sku: string; name: string; unit: string; price: string; minOrder: number }[];
  visibleNotes: string;
  hiddenText: string;
  priceListUrl: string;
}

interface Variant {
  tag?: "avg" | "bad";
  label: string;
  href: string;
}

function variantLink(v: Variant): string {
  const tag = v.tag === "avg" ? '<span class="tag-avg">AVERAGE</span>' : v.tag === "bad" ? '<span class="tag-bad">BAD</span>' : "";
  return `<a class="btn" href="${esc(v.href)}">${tag}${esc(v.label)}</a>`;
}

const DIRECTOR_SCENES: { name: string; desc: string; variants: Variant[] }[] = [
  {
    name: "Tap to Pay (simulated)",
    desc: "A phone wallet pays at card terminals.",
    variants: [
      { tag: "avg", label: "Coffee €4.20", href: "/mock/stage/tap?v=average" },
      { tag: "bad", label: "Currency trick (DCC)", href: "/mock/stage/tap?v=bad" },
      { tag: "bad", label: "Second charge on a one-time card", href: "/mock/stage/tap?v=bad2" },
    ],
  },
  {
    name: "Super-App Wallet (simulated, 中文)",
    desc: "Scan-to-pay in Shanghai, with Kassa's handoff.",
    variants: [
      { tag: "avg", label: "Pay dorm ¥1,800", href: "/mock/stage/wallet?v=average" },
      { tag: "bad", label: "Swapped QR code", href: "/mock/stage/wallet?v=bad" },
      { tag: "avg", label: "Spending notices (中文)", href: "/mock/stage/wallet?v=notify" },
    ],
  },
  {
    name: "Mail (simulated)",
    desc: "Forward bills to Kassa.",
    variants: [
      { tag: "avg", label: "Tuition invoice", href: "/mock/stage/mail?v=average" },
      { tag: "bad", label: "Lookalike landlord: new IBAN", href: "/mock/stage/mail?v=bad" },
    ],
  },
  {
    name: "Bank App (simulated)",
    desc: "Follow a transfer live.",
    variants: [
      { tag: "avg", label: "Track tuition transfer", href: "/mock/stage/bank?v=average" },
      { tag: "bad", label: "Forged bank message", href: "/mock/stage/bank?v=bad" },
    ],
  },
  {
    name: "Money from home (simulated)",
    desc: "Parents send tenge.",
    variants: [{ tag: "avg", label: "Send ₸1,000,000", href: "/mock/stage/home?v=average" }],
  },
  {
    name: "Supplier Price List",
    desc: "A PDF with a hidden instruction for AI.",
    variants: [{ tag: "bad", label: "Show the hidden text (A1)", href: "/mock/stage/supplier?v=bad" }],
  },
];

const DIRECTOR_SCRIPT = `
const out = document.getElementById("out");
const resetBtn = document.getElementById("reset");
function bind(id, action, body) {
  const btn = document.getElementById(id);
  btn.addEventListener("click", () => window.stage.run(btn, action, body, out));
}
bind("clock1", "clock", { hours: 1 });
bind("clock72", "clock", { hours: 72 });
resetBtn.addEventListener("click", () => {
  if (!confirm("Reset the demo to the seed?")) return;
  window.stage.run(resetBtn, "reset", {}, out);
});
window.stage.state().then((s) => {
  if (!s.demoTokenConfigured) {
    window.stage.show(document.getElementById("tokenwarn"), {
      tone: "warn",
      title: "No demo token configured",
      detail: "Set DEMO_ADMIN_TOKEN for mock-world (bun run env:setup) or stage actions will be refused."
    });
  }
}).catch(() => {});
`;

export function renderDirector(): string {
  const scenes = DIRECTOR_SCENES.map(
    (s) => `<section class="card scene">
<h2>${esc(s.name)}</h2>
<p class="muted">${esc(s.desc)}</p>
<div class="variants">${s.variants.map(variantLink).join("")}</div>
</section>`,
  ).join("\n");

  const body = `<h1>Demo Stage</h1>
<p class="muted">The outside world, simulated. Open Kassa on this phone or a second screen; each button opens a scene. Average first, then the attack.</p>
<div class="director-grid">
${scenes}
</div>
<section class="card">
<h2>Presenter controls</h2>
<button type="button" class="btn secondary" id="clock1">Clock +1 hour</button>
<button type="button" class="btn secondary" id="clock72">Clock +3 days (rent day)</button>
<button type="button" class="btn danger" id="reset">Reset demo</button>
<div class="status" id="out" hidden aria-live="polite"></div>
<div class="status" id="tokenwarn" hidden aria-live="polite"></div>
</section>`;

  return stagePage({
    title: "Demo Stage",
    appName: "Demo Stage (simulated)",
    back: false,
    body,
    script: DIRECTOR_SCRIPT,
    caption: {
      codes: ["I1", "I2", "I6", "I13"],
      points: [
        "Every screen here is the outside world: shops, wallets, mail, banks. None of them can make Kassa pay.",
        "Kassa's agent only drafts orders; deterministic rules decide; money moves only with a passkey signature over the exact order (I1, I2).",
        "Events from outside (notifications, emails, bank messages) can only log or draft, never approve (I6); webhooks must carry a valid HMAC signature (I13).",
      ],
    },
  });
}

const TAP_SCRIPT = `
const $ = (id) => document.getElementById(id);
const tapCoffee = $("tapCoffee");
tapCoffee.addEventListener("click", async () => {
  if (tapCoffee.classList.contains("tapping")) return;
  tapCoffee.classList.add("tapping");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  tapCoffee.classList.remove("tapping");
  await window.stage.run(tapCoffee, "tap-coffee", {}, $("outCoffee"));
});
const tapDcc = $("tapDcc");
tapDcc.addEventListener("click", () => window.stage.run(tapDcc, "tap-dcc", {}, $("outDcc")));
const settleDcc = $("settleDcc");
settleDcc.addEventListener("click", () => window.stage.run(settleDcc, "tap-dcc-settle", {}, $("outSettle")));
const input = $("cardId");
function tapCard(btn, out) {
  const cardId = input.value.trim();
  if (!cardId) {
    window.stage.show(out, { ok: false, tone: "warn", title: "Card id missing", detail: "Approve a pizza order in Kassa first." });
    return;
  }
  window.stage.run(btn, "tap-card", { cardId: cardId }, out);
}
const charge = $("charge");
const chargeAgain = $("chargeAgain");
charge.addEventListener("click", () => tapCard(charge, $("outCard")));
chargeAgain.addEventListener("click", () => tapCard(chargeAgain, $("outCardAgain")));
window.stage.state().then((s) => {
  if (s.tap && s.tap.lastCardId && !input.value) input.value = s.tap.lastCardId;
  if (s.tap && s.tap.pendingDcc) {
    window.stage.show($("outDcc"), {
      ok: false,
      tone: "warn",
      title: "Waiting for the statement",
      detail: s.tap.pendingDcc.charged + " charged for " + s.tap.pendingDcc.local
    });
  }
}).catch(() => {});
`;

export function renderTap(): string {
  const body = `<div class="pay-card" aria-label="Debit card (example, simulated)">
<div class="row"><span>Debit card (example)</span><span class="muted">Home bank</span></div>
<div class="num">•••• 4821</div>
<div class="row"><span>DANA S.</span><span>KZT</span></div>
</div>

<section id="average" class="card">
<h2>Coffee Shop in Budapest</h2>
<div class="amount">€4.20</div>
<button type="button" class="tap-zone" id="tapCoffee">Hold near reader</button>
<div class="status" id="outCoffee" hidden aria-live="polite"></div>
</section>

<section id="bad" class="card">
<h2>Gift Shop in Budapest</h2>
<p class="muted">Price HUF 12,990.00. The terminal offers: “Pay in your home currency (KZT)?”</p>
<button type="button" class="tap-zone" id="tapDcc">Accept KZT and tap</button>
<div class="status" id="outDcc" hidden aria-live="polite"></div>
<button type="button" class="btn secondary" id="settleDcc">Statement arrives (settle)</button>
<div class="status" id="outSettle" hidden aria-live="polite"></div>
</section>

<section id="bad2" class="card">
<h2>Pizza Shop in Budapest terminal</h2>
<p class="muted">Paste the one-time card id from the Kassa approval (2 × Margherita).</p>
<input class="field" id="cardId" autocomplete="off" placeholder="One-time card id">
<button type="button" class="btn" id="charge">Tap one-time card</button>
<div class="status" id="outCard" hidden aria-live="polite"></div>
<button type="button" class="btn secondary" id="chargeAgain">Terminal charges again</button>
<div class="status" id="outCardAgain" hidden aria-live="polite"></div>
</section>`;

  return stagePage({
    title: "Tap to Pay",
    appName: "Tap to Pay (simulated)",
    body,
    script: TAP_SCRIPT,
    caption: {
      codes: ["I6", "I13", "I2", "I4"],
      points: [
        "Coffee: the phone's wallet automation sends the purchase to Kassa with its own device token (I13). Kassa logs it, converts it and updates the budget. A capture can never pay (I6).",
        "Currency trick: the terminal charged in tenge at about 6% over the mid rate (dynamic currency conversion). When the statement arrives, Kassa's fee x-ray flags it and tells you to pay in the local currency next time.",
        "One-time card: Kassa issues a card for exactly the signed order. The first charge passes; the terminal's second try is declined (CARD_ALREADY_USED, I2, I4).",
      ],
    },
  });
}

const WALLET_NOTICES = [
  "交易提醒\n你在 便利店(示例) 消费 ¥32.50\n付款方式：余额\n交易时间：2026-10-26 12:30:41",
  "支付成功\n¥45.00\n收款方：面馆(示例)\n支付时间：2026年10月26日 18:20:11\n支付方式：零钱",
];

const WALLET_SCRIPT = `
const $ = (id) => document.getElementById(id);
let currentPaymentId = null;
let swapAll = false;
let payBusy = false;

function render(s) {
  const p = s.wallet ? s.wallet.latest : null;
  swapAll = !!(s.wallet && s.wallet.swapAll);
  $("swap").textContent = swapAll ? "关闭攻击 Turn attack off" : "开启攻击 Turn attack on";
  if (!p) {
    currentPaymentId = null;
    $("qrEmpty").hidden = false;
    $("qrView").hidden = true;
    return;
  }
  currentPaymentId = p.paymentId;
  $("qrEmpty").hidden = true;
  $("qrView").hidden = false;
  $("payee").textContent = p.payeeName;
  $("amount").textContent = p.amount;
  $("ref").textContent = p.reference ? "备注 Ref: " + p.reference : "";
  $("payload").textContent = p.qrPayload;
  const paid = p.status === "PAID";
  const qs = $("qrStatus");
  qs.textContent = paid ? "已付款 Paid" : "待付款 Pending";
  qs.className = paid ? "chip ok" : "chip warn";
  const pay = $("pay");
  if (p.swapped) {
    const w = $("swapWarn");
    w.hidden = false;
    w.textContent = "警告：此码收款方是 " + p.payeeName + "，不是 " + p.intendedPayeeName + "。Kassa refused before signing (QR_PAYEE_MISMATCH): it never sent you here.";
    pay.hidden = true;
  } else {
    $("swapWarn").hidden = true;
    pay.hidden = false;
    pay.disabled = paid || payBusy;
  }
}

async function refresh() {
  try {
    render(await window.stage.state());
  } catch (e) {
    /* keep the last view */
  }
}

$("pay").addEventListener("click", async () => {
  if (!currentPaymentId) return;
  payBusy = true;
  try {
    await window.stage.run($("pay"), "wallet-pay", { paymentId: currentPaymentId }, $("outPay"));
  } finally {
    payBusy = false;
    refresh();
  }
});

$("swap").addEventListener("click", async () => {
  await window.stage.run($("swap"), "wallet-swap", { enabled: !swapAll }, $("outSwap"));
  refresh();
});

$("notifyBtn").addEventListener("click", () => window.stage.run($("notifyBtn"), "wallet-notify", {}, $("outNotify")));

refresh();
setInterval(refresh, 2000);
`;

export function renderWallet(): string {
  const notices = WALLET_NOTICES.map((n) => `<div class="card"><div class="mail-body">${esc(n)}</div></div>`).join("\n");

  const body = `<section id="average" class="card">
<h2>扫码付款</h2>
<p class="muted">Scan to pay</p>
<div id="qrEmpty" class="muted">等待 Kassa 生成付款码…<br>Waiting for Kassa: approve the dorm fee in Kassa (region CN).</div>
<div id="qrView" hidden>
<div class="muted">收款方 Payee</div>
<h2 id="payee"></h2>
<div class="amount" id="amount"></div>
<div class="muted" id="ref"></div>
<div class="qr-box" role="img" aria-label="QR code (simulated)"></div>
<details>
<summary class="muted">付款码内容 Code payload</summary>
<div class="mono" id="payload"></div>
</details>
<span class="chip" id="qrStatus"></span>
<div id="swapWarn" class="warning-block" hidden></div>
<button type="button" class="btn" id="pay">确认付款 Pay</button>
<div class="status" id="outPay" hidden aria-live="polite"></div>
</div>
</section>

<section id="bad" class="card">
<h2>演示攻击：调换付款码</h2>
<p class="muted">Attack demo: swap the next QR code (A5)</p>
<button type="button" class="btn secondary" id="swap">开启攻击 Turn attack on</button>
<div class="status" id="outSwap" hidden aria-live="polite"></div>
<p class="muted">Then ask Kassa to pay Buy Everything Shop from China ¥349: Kassa compares the payee in the code with the verified payee before you sign.</p>
</section>

<section id="notify" class="card">
<h2>消费通知</h2>
<p class="muted">Spending notices</p>
${notices}
<p class="muted">Plus your home bank's notice: ¥268.00 on card •••• 4821.</p>
<button type="button" class="btn" id="notifyBtn">发送到 Kassa Send to Kassa</button>
<div class="status" id="outNotify" hidden aria-live="polite"></div>
</section>`;

  return stagePage({
    title: "超级应用钱包 Super-App Wallet",
    appName: "超级应用钱包 Super-App Wallet (simulated)",
    lang: "zh-CN",
    body,
    script: WALLET_SCRIPT,
    caption: {
      codes: ["A5", "I3", "I2", "I6"],
      points: [
        "In region CN Kassa does not pay itself: it prepares the exact order, you sign it, and you pay in the wallet (handoff).",
        "Before you sign, Kassa checks that the payee in the QR code is the verified payee. A swapped code (Unknown Trading Company) is refused with QR_PAYEE_MISMATCH: there is nothing to sign and no Pay button (A5).",
        "Chinese spending notices are logged in CNY with the tenge equivalent at the purchase-date rate. A notice can only log, never pay (I6).",
      ],
    },
  });
}

const MAIL_SCRIPT = `
document.querySelectorAll("[data-forward]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-forward");
    window.stage.run(btn, "mail-forward", { id: id }, document.getElementById("out-" + id));
  });
});
const rentDay = document.getElementById("rentDay");
if (rentDay) {
  rentDay.addEventListener("click", () => window.stage.run(rentDay, "clock", { hours: 72 }, document.getElementById("outRent")));
}
setTimeout(() => {
  const focused = document.querySelector(".focus");
  if (focused && focused.tagName === "DETAILS") focused.open = true;
}, 0);
`;

export function renderMail(emails: StageEmail[]): string {
  const items = emails
    .map((m) => {
      const id = esc(m.id);
      const domId = m.id === "msg-0001" ? "average" : m.id === "msg-0005" ? "bad" : `mail-${m.id}`;
      const attachments = m.attachments
        .map((a) => `<p><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}</a></p>`)
        .join("\n");
      const forward =
        m.id === "msg-0001" || m.id === "msg-0005"
          ? `<button type="button" class="btn" data-forward="${id}">Forward to Kassa</button>
<div class="status" id="out-${id}" hidden aria-live="polite"></div>`
          : "";
      const rent =
        m.id === "msg-0005"
          ? `<button type="button" class="btn secondary" id="rentDay">Jump to rent day (+3 days)</button>
<div class="status" id="outRent" hidden aria-live="polite"></div>
<p class="muted">Then open the <a href="/mock/stage/bank">Bank App</a>: rent goes to the verified account.</p>`
          : "";
      return `<details class="mail-item" id="${esc(domId)}">
<summary>
<div class="mail-from">${esc(m.from)}</div>
<div class="mail-subject">${esc(m.subject)}</div>
<div class="mail-date">${esc(m.date.slice(0, 10))}</div>
</summary>
<div class="mail-body">${esc(m.body)}</div>
${attachments}
${forward}
${rent}
</details>`;
    })
    .join("\n");

  const body = `<h1>Inbox</h1>
<p class="muted">dana@student.example (simulated)</p>
${items}`;

  return stagePage({
    title: "Mail",
    appName: "Mail (simulated)",
    body,
    script: MAIL_SCRIPT,
    caption: {
      codes: ["I10", "I7", "A2", "I5"],
      points: [
        "Forwarded mail is untrusted data. Kassa's Reader extracts payee, account, amount and reference, and the server checks every value against the document text (I10).",
        "The lookalike email asks to move rent to a new IBAN. In Kassa a changed account is a new payee in 24-hour cooling that needs a passkey; autopay never uses it (I7, A2).",
        "Rent autopay on rent day still pays the verified landlord account, within the signed mandate and the independent daily cap (I5).",
      ],
    },
  });
}

const BANK_STEPS: { state: string; label: string }[] = [
  { state: "incoming_payment_waiting", label: "Waiting for funds" },
  { state: "processing", label: "Processing" },
  { state: "funds_converted", label: "Funds converted" },
  { state: "outgoing_payment_sent", label: "Sent to the payee" },
];

const BANK_SCRIPT = `
const $ = (id) => document.getElementById(id);
const STEPS = ${JSON.stringify(BANK_STEPS)};

function renderTransfers(s) {
  const list = (s.bank && s.bank.transfers) || [];
  if (list.length === 0) {
    $("none").hidden = false;
    $("tx").hidden = true;
    $("older").textContent = "";
    return;
  }
  const t = list[0];
  $("none").hidden = true;
  $("tx").hidden = false;
  $("ref").textContent = t.reference;
  $("target").textContent = t.target;
  $("source").textContent = "From " + t.source;

  const doneAt = {};
  (t.history || []).forEach((h) => { doneAt[h.state] = h.at; });

  const steps = $("steps");
  while (steps.firstChild) steps.removeChild(steps.firstChild);
  STEPS.forEach((step) => {
    const li = document.createElement("li");
    const isCurrent = step.state === t.status;
    const inHistory = Object.prototype.hasOwnProperty.call(doneAt, step.state);
    if (isCurrent) {
      li.className = t.status === "outgoing_payment_sent" ? "done" : "current";
    } else if (inHistory) {
      li.className = "done";
    }
    li.appendChild(document.createTextNode(step.label));
    if (inHistory) {
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = " " + window.stage.fmtTime(doneAt[step.state]);
      li.appendChild(time);
    }
    steps.appendChild(li);
  });

  const older = $("older");
  while (older.firstChild) older.removeChild(older.firstChild);
  list.slice(1, 5).forEach((o) => {
    const li = document.createElement("li");
    li.textContent = "#" + o.id + " " + o.reference + ": " + o.status;
    older.appendChild(li);
  });
}

async function refresh() {
  try {
    renderTransfers(await window.stage.state());
  } catch (e) {
    /* keep the last view */
  }
}

const ff = $("ff");
ff.addEventListener("click", async () => {
  await window.stage.run(ff, "clock", { hours: 1 }, $("outFf"));
  refresh();
});

const forge = $("forge");
forge.addEventListener("click", () => window.stage.run(forge, "bank-forged", {}, $("outForge")));

refresh();
setInterval(refresh, 2000);
`;

export function renderBank(): string {
  const body = `<section id="average" class="card">
<h2>Transfer status</h2>
<div id="none" class="muted">No transfers yet. Approve the tuition payment in Kassa.</div>
<div id="tx" hidden>
<div class="muted" id="ref"></div>
<div class="amount" id="target"></div>
<div class="muted" id="source"></div>
<ol class="timeline" id="steps"></ol>
</div>
<ul id="older" class="muted"></ul>
<button type="button" class="btn secondary" id="ff">Fast-forward +1 hour</button>
<div class="status" id="outFf" hidden aria-live="polite"></div>
</section>

<section id="bad" class="card">
<h2>A fake bank says “SENT”</h2>
<p class="muted">Someone without the bank's key posts a transfer-sent message to Kassa: once unsigned, once signed with a made-up key.</p>
<button type="button" class="btn danger" id="forge">Send forged message</button>
<div class="status" id="outForge" hidden aria-live="polite"></div>
</section>`;

  return stagePage({
    title: "Bank App",
    appName: "Bank App (simulated)",
    body,
    script: BANK_SCRIPT,
    caption: {
      codes: ["I13", "I12"],
      points: [
        "The bank app follows Kassa's transfer at the simulated bank: waiting for funds, processing, converted, sent. Each step reaches Kassa as a webhook signed with a shared secret (HMAC-SHA256, 5-minute window).",
        "A forged message without a valid signature is rejected with 401 and changes nothing (I13). Every accepted state change is written to Kassa's append-only, hash-chained ledger (I12).",
      ],
    },
  });
}

const HOME_SCRIPT = `
const send = document.getElementById("send");
send.addEventListener("click", () => window.stage.run(send, "home-send", {}, document.getElementById("outSend")));
`;

export function renderHome(): string {
  const body = `<section id="average" class="card">
<div class="muted">From</div>
<h2>Parents (simulated)</h2>
<div class="muted">To</div>
<h2>Dana S. · simulated bank wallet</h2>
<div class="amount">₸1,000,000</div>
<div class="muted">Sent early for tuition</div>
<button type="button" class="btn" id="send">Send money</button>
<div class="status" id="outSend" hidden aria-live="polite"></div>
</section>
<p class="muted">Then open Kassa: routes and coverage update.</p>`;

  return stagePage({
    title: "Money from home",
    appName: "Money from home (simulated)",
    body,
    script: HOME_SCRIPT,
    caption: {
      codes: ["I6", "I2"],
      points: [
        "Kassa gets a signed notice of the incoming tenge and recomputes the cheapest routes and the coverage forecast for tuition and rent.",
        "Money arriving is only an event: nothing is paid until you approve the exact order with your passkey (I6, I2).",
      ],
    },
  });
}

const SUPPLIER_SCRIPT = `
const wrap = document.getElementById("hiddenWrap");
const toggle = document.getElementById("toggle");
toggle.addEventListener("click", () => {
  const on = wrap.classList.toggle("reveal");
  toggle.textContent = on ? "Hide hidden text" : "Show hidden text";
});
`;

export function renderSupplier(s: StageSupplier): string {
  const rows = s.items
    .map(
      (i) => `<tr>
<td>${esc(i.name)}<br><span class="muted">${esc(i.sku)}</span></td>
<td>${esc(i.unit)}</td>
<td>${esc(i.price)}</td>
<td>${esc(i.minOrder)}</td>
</tr>`,
    )
    .join("\n");

  const body = `<section id="bad" class="card">
<h1>${esc(s.name)}</h1>
<div class="muted">${esc(s.city)}</div>
<table class="items">
<thead><tr><th>Item</th><th>Unit</th><th>Price</th><th>Min</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="muted">${esc(s.visibleNotes)}</p>
<div id="hiddenWrap"><span class="hidden-text">${esc(s.hiddenText)}</span></div>
<button type="button" class="btn secondary" id="toggle">Show hidden text</button>
<p><a class="btn secondary" href="${esc(s.priceListUrl)}" target="_blank" rel="noopener">Open the price list PDF</a></p>
</section>`;

  return stagePage({
    title: "Supplier Price List",
    appName: "Supplier Price List (simulated)",
    body,
    script: SUPPLIER_SCRIPT,
    caption: {
      codes: ["A1", "I10", "I1", "I2"],
      points: [
        "The supplier's PDF hides white 1-point text addressed to AI assistants, asking for an extra payment to a collections account. A human never sees it; an AI reading the text layer does.",
        "Kassa treats document text as data, never instructions. The Reader returns typed fields with evidence; the planner has no payment tool (I1, I10).",
        "Even a fooled planner can only propose: an unknown account is refused (REFUSE_UNVERIFIED_PAYEE) and nothing moves without your passkey (I2).",
      ],
    },
  });
}
