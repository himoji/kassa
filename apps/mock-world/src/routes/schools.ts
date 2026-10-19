import { DEMO_TOKEN_HEADER, formatIbanPrint, verifySchoolPortalAccess } from "@kassa/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { adminTokenMatches, kassaSigned } from "../access.ts";
import type { MockWorldConfig } from "../config.ts";
import { HttpError } from "../errors.ts";
import { esc, page } from "../html.ts";
import { parseStudentId, resolveSchool, type School, type SchoolBook, searchSchools } from "../school/schools.ts";

/*
 * (added 2026-10-15) School payment portals (simulated third-party systems, fictitious schools):
 *   GET /schools?q=                          the directory (with the account each school is paid to)
 *   POST /schools/:id/invoices               {studentId, dateOfBirth | access}: the student's invoices, payments
 *                                            booked against them, unmatched payments. The student proves who they are
 *                                            (SchoolBook.verify; `access` is a Kassa portal link, webhookHmac.ts).
 *   GET /schools/:id/invoices?studentId=     the same for Kassa only on a deployed build (its signed request or the demo
 *                                            admin token): a student Kassa already linked, or a judge copy's own.
 *                                            Local development leaves it open, like the control routes (access.ts).
 *   GET /schools/:id/portal?studentId=       the school's payment portal page: sign in with student ID and date of
 *                                            birth, or opened from Kassa with `&access=` (refreshes itself)
 * A wrong date of birth and an unknown student read the same (403 STUDENT_NOT_VERIFIED); too many wrong dates for
 * one student → 429 TOO_MANY_ATTEMPTS. Payments reach the portal from the mock bank (SchoolBook.onPayout), never from
 * these routes.
 */

const publicSchool = (s: School) => ({
  id: s.id,
  name: s.name,
  city: s.city,
  country: s.country,
  currency: s.currency,
  account: { iban: s.iban, bic: s.bic, holder: s.name },
  term: s.term,
  simulated: true as const,
});

type Q = { q?: unknown; studentId?: unknown; access?: unknown };
type ProofBody = { studentId?: unknown; dateOfBirth?: unknown; access?: unknown };

const realNowSeconds = () => Math.floor(Date.now() / 1000);

export function schoolRoutes(app: FastifyInstance, deps: { book: SchoolBook; config: MockWorldConfig }): void {
  const { book, config } = deps;

  const invoicesOf = async (s: School, studentId: string) => ({ school: publicSchool(s), invoices: await book.invoicesFor(s, studentId), unmatched: book.unmatchedFor(s.id), simulated: true });

  /** Kassa's own read (signed request) or the operator's, on a deployed build. */
  const kassaOrOperator = (req: FastifyRequest) => !config.locked || adminTokenMatches(req.headers[DEMO_TOKEN_HEADER], config.demoAdminToken) || kassaSigned(req, config, realNowSeconds());

  app.get("/schools", async (req) => {
    const q = typeof (req.query as Q).q === "string" ? ((req.query as Q).q as string).slice(0, 60) : "";
    return { schools: searchSchools(q).map(publicSchool), simulated: true };
  });

  app.get("/schools/:id/invoices", async (req) => {
    if (!kassaOrOperator(req)) throw new HttpError(401, "KASSA_AUTH_REQUIRED", "Sign in with the student's date of birth (POST) to see invoices");
    const s = resolveSchool((req.params as { id?: unknown }).id);
    const studentId = parseStudentId((req.query as Q).studentId);
    return invoicesOf(s, studentId);
  });

  app.post("/schools/:id/invoices", async (req) => {
    const s = resolveSchool((req.params as { id?: unknown }).id);
    const body = (req.body ?? {}) as ProofBody;
    const studentId = parseStudentId(body.studentId);
    if (body.access !== undefined && verifySchoolPortalAccess(config.hmacSecret, body.access, s.id, studentId, realNowSeconds())) return invoicesOf(s, studentId);
    const v = book.verify(s, studentId, body.dateOfBirth);
    if (!v.ok && v.reason === "TOO_MANY_ATTEMPTS") throw new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many wrong dates of birth for this student; try again in 15 minutes");
    if (!v.ok) throw new HttpError(403, "STUDENT_NOT_VERIFIED", "No student with that ID and date of birth");
    return invoicesOf(s, studentId);
  });

  app.get("/schools/:id/portal", async (req, reply) => {
    const s = resolveSchool((req.params as { id?: unknown }).id);
    const q = req.query as Q;
    const raw = q.studentId;
    const studentId = typeof raw === "string" && /^[A-Za-z0-9-]{4,20}$/.test(raw.trim()) ? raw.trim().toUpperCase() : "";
    // From Kassa (webhookHmac.ts schoolPortalAccess): already signed in. Anything else: the student signs in here.
    const access = studentId && verifySchoolPortalAccess(config.hmacSecret, q.access, s.id, studentId, realNowSeconds()) ? String(q.access).trim() : "";
    const body = `
<h1>${esc(s.name)}: tuition payments</h1>
<p class="muted">Simulated school payment portal (${esc(s.city)}). In production this is the school's payment partner.</p>
<form id="signin" class="card"${access ? " hidden" : ""}>
  <h2>Sign in to see your invoices</h2>
  <label for="sid">Student ID</label>
  <input id="sid" name="studentId" value="${esc(studentId)}" autocomplete="off" placeholder="e.g. KZ26-0417" required pattern="[A-Za-z0-9-]{4,20}">
  <label for="dob">Date of birth</label>
  <input id="dob" name="dateOfBirth" type="date" autocomplete="bday" required>
  <p><button type="submit">Show my invoices</button></p>
</form>
<p id="who" class="muted"${access ? "" : " hidden"}>Signed in from Kassa as student ${esc(studentId)}.</p>
<div class="card">
  <h2>Pay by bank transfer</h2>
  <table>
    <tr><th>Account holder</th><td>${esc(s.name)}</td></tr>
    <tr><th>IBAN</th><td class="mono">${esc(formatIbanPrint(s.iban))}</td></tr>
    <tr><th>BIC</th><td class="mono">${esc(s.bic)}</td></tr>
    <tr><th>Currency</th><td>${esc(s.currency)}</td></tr>
  </table>
  <p class="muted">Always put your invoice's reference in the payment. Payments without it are matched by hand and take longer.</p>
</div>
<div id="invoices" aria-live="polite">${access ? '<p class="muted">Loading…</p>' : '<p class="muted">Sign in with your student ID and date of birth to see your invoices.</p>'}</div>
<div id="unmatched"></div>`;
    const script = `
const URL_ = ${JSON.stringify(`/mock/schools/${s.id}/invoices`)};
let creds = ${access ? JSON.stringify({ studentId, access }) : "null"};
let timer = null;
const fmt = (m, c) => new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(m / 100);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
const LABEL = { OPEN: 'Open', PARTLY_PAID: 'Partly paid', PAID: 'Paid' };
function stop(message) {
  if (timer) clearInterval(timer);
  timer = null; creds = null;
  document.getElementById('signin').hidden = false;
  document.getElementById('who').hidden = true;
  document.getElementById('unmatched').replaceChildren();
  document.getElementById('invoices').replaceChildren(el('p', 'bad', message));
}
async function load() {
  if (!creds) return;
  const res = await fetch(URL_, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) });
  const box = document.getElementById('invoices');
  if (res.status === 429) return stop('Too many wrong dates of birth for this student. Try again in 15 minutes.');
  if (!res.ok) return stop(creds.access ? 'This link has expired. Sign in with your student ID and date of birth.' : 'No student with that ID and date of birth.');
  const { invoices, unmatched } = await res.json();
  box.replaceChildren();
  for (const i of invoices) {
    const card = el('div', 'card');
    card.append(el('h2', '', i.term + ' tuition, student ' + i.studentId));
    card.append(el('div', 'amount', fmt(i.amountMinor, i.currency)));
    card.append(el('div', 'status ' + (i.status === 'PAID' ? 'ok' : i.status === 'OPEN' ? '' : 'bad'), LABEL[i.status] + (i.status === 'PARTLY_PAID' ? ': ' + fmt(i.amountMinor - i.paidMinor, i.currency) + ' still due' : '')));
    const t = el('table');
    const row = (k, v, mono) => { const r = el('tr'); r.append(el('th', '', k), el('td', mono ? 'mono' : '', v)); t.append(r); };
    row('Invoice', i.invoiceId, true); row('Due', i.dueDate); row('Reference', i.reference, true);
    card.append(t);
    if (i.payments.length) {
      card.append(el('h2', '', 'Payments received'));
      const list = el('ul');
      for (const p of i.payments) list.append(el('li', '', fmt(p.amountMinor, p.currency) + ' on ' + p.receivedAt.slice(0, 10) + ' (bank transfer ' + p.transferId + ')'));
      card.append(list);
    }
    box.append(card);
  }
  const um = document.getElementById('unmatched');
  um.replaceChildren();
  if (unmatched.length) {
    const card = el('div', 'card');
    card.append(el('h2', '', 'Payments we could not match'), el('p', 'muted', 'These arrived without a known invoice reference. The bursar matches them by hand.'));
    const list = el('ul');
    for (const p of unmatched) list.append(el('li', '', fmt(p.amountMinor, p.currency) + ', reference "' + p.reference + '"'));
    card.append(list); um.append(card);
  }
}
function start() { load(); if (!timer) timer = setInterval(load, 2000); }
document.getElementById('signin').addEventListener('submit', (e) => {
  e.preventDefault();
  creds = { studentId: document.getElementById('sid').value.trim().toUpperCase(), dateOfBirth: document.getElementById('dob').value };
  document.getElementById('signin').hidden = true;
  const who = document.getElementById('who');
  who.textContent = 'Signed in as student ' + creds.studentId + '.'; who.hidden = false;
  document.getElementById('invoices').replaceChildren(el('p', 'muted', 'Loading…'));
  start();
});
if (creds) start();`;
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("referrer-policy", "no-referrer").send(page(`${s.name} portal`, body, { script }));
  });
}
