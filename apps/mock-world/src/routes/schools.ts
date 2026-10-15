import { formatIbanPrint } from "@kassa/shared";
import type { FastifyInstance } from "fastify";

import { esc, page } from "../html.ts";
import { parseStudentId, resolveSchool, type School, type SchoolBook, searchSchools } from "../school/schools.ts";

/*
 * (added 2026-10-15) School payment portals (simulated third-party systems, fictitious schools):
 *   GET /schools?q=                          the directory (with the account each school is paid to)
 *   GET /schools/:id/invoices?studentId=     the student's invoices, payments booked against them, unmatched payments
 *   GET /schools/:id/portal?studentId=       the school's payment portal page (refreshes itself)
 * Payments reach the portal from the mock bank (SchoolBook.onPayout), never from these routes.
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

type Q = { q?: unknown; studentId?: unknown };

export function schoolRoutes(app: FastifyInstance, deps: { book: SchoolBook }): void {
  const { book } = deps;

  app.get("/schools", async (req) => {
    const q = typeof (req.query as Q).q === "string" ? ((req.query as Q).q as string).slice(0, 60) : "";
    return { schools: searchSchools(q).map(publicSchool), simulated: true };
  });

  app.get("/schools/:id/invoices", async (req) => {
    const s = resolveSchool((req.params as { id?: unknown }).id);
    const studentId = parseStudentId((req.query as Q).studentId);
    return { school: publicSchool(s), invoices: await book.invoicesFor(s, studentId), unmatched: book.unmatchedFor(s.id), simulated: true };
  });

  app.get("/schools/:id/portal", async (req, reply) => {
    const s = resolveSchool((req.params as { id?: unknown }).id);
    const raw = (req.query as Q).studentId;
    const studentId = typeof raw === "string" && /^[A-Za-z0-9-]{4,20}$/.test(raw.trim()) ? raw.trim().toUpperCase() : "";
    const body = `
<h1>${esc(s.name)}: tuition payments</h1>
<p class="muted">Simulated school payment portal (${esc(s.city)}). In production this is the school's payment partner.</p>
<form class="card" method="get">
  <label for="sid">Student ID</label>
  <input id="sid" name="studentId" value="${esc(studentId)}" autocomplete="off" placeholder="e.g. KZ26-0417">
  <p><button type="submit">Show my invoices</button></p>
</form>
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
<div id="invoices" aria-live="polite">${studentId ? '<p class="muted">Loading…</p>' : '<p class="muted">Enter your student ID to see your invoices.</p>'}</div>
<div id="unmatched"></div>`;
    const script = studentId
      ? `
const URL_ = ${JSON.stringify(`/mock/schools/${s.id}/invoices?studentId=${encodeURIComponent(studentId)}`)};
const fmt = (m, c) => new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(m / 100);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
const LABEL = { OPEN: 'Open', PARTLY_PAID: 'Partly paid', PAID: 'Paid' };
async function load() {
  const res = await fetch(URL_, { cache: 'no-store' });
  const box = document.getElementById('invoices');
  if (!res.ok) { box.replaceChildren(el('p', 'bad', 'No student with that ID.')); return; }
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
load(); setInterval(load, 2000);`
      : "";
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(page(`${s.name} portal`, body, script ? { script } : {}));
  });
}
