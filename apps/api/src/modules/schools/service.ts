/*
 * (added 2026-10-15) "Find your school" (shared/school.ts): the school directory and each student's invoices come
 * from the schools' payment portals (mock-world; in production a partner such as Flywire or Convera).
 *
 *  - lookup: the school and the student's open invoices; writes nothing.
 *  - (2026-10-19) Both lookup and linkSchool first need the school to confirm the student: the student's date of birth,
 *    checked by the school's portal (mock-world POST /schools/:id/invoices), never kept by Kassa. A wrong or missing
 *    date and an unknown student ID get the same 422 STUDENT_NOT_VERIFIED; tries are limited per user
 *    (SCHOOL_PROOF_TRIES_PER_HOUR), per IP (http/security.ts) and per student at the portal. Judge build: the seeded
 *    student ID means the reviewer's own copy (ownStudentId), which needs no date. Kassa reads a student's invoices
 *    without the date (its signed request) only for that copy and for a recipient it linked after the school confirmed
 *    the student (refreshInvoices; payees/service.ts keeps `portalSchoolId` server-set).
 *  - linkSchool: the tuition recipient (the directory's name and account; it still cools for 24 h like any new
 *    recipient, I7) plus a bill for each open invoice, with the exact amount, due date and reference. Adding the same
 *    school and student again reuses the recipient, and an invoice already imported is not imported twice.
 *  - refreshInvoices: imports new invoices for an existing tuition recipient from the directory.
 *  - onSchoolWebhook: the portal booked a payment against an invoice. Only a claim by the school (I6): it is
 *    recorded on the payment it names and told to the user; it never pays, approves or changes a bill.
 */
import { type RecipientDetails, type SchoolDto, type SchoolInvoiceDto, type SchoolLinkResponse, type SchoolLookupResponse } from "@kassa/shared";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { judgeCopyStudentId, judgeCopySuffixOf } from "../../../../../fixtures/judge-copy.ts";
import { getDb } from "../../db/client.ts";
import { obligations, payees, payments } from "../../db/schema.ts";
import { conflict, HttpProblem, notFound } from "../../http/problem.ts";
import { incrCounter } from "../../http/rate-limit-store.ts";
import { judgeModeActive } from "../auth/dev.ts";
import { clock, isoDate } from "../clock/index.ts";
import { loadSeedData } from "../demo/seed.ts";
import { ledger } from "../ledger/index.ts";
import { notify } from "../notifications/service.ts";
import { createObligation } from "../obligations/service.ts";
import { accountHash, readDetails } from "../payees/crypto.ts";
import { createPayee, toPayeeDto, updatePayeeDetails } from "../payees/service.ts";
import { mockWorld, MockWorldError } from "../rails/http.ts";

const DirectorySchool = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  country: z.string().length(2),
  currency: z.string().length(3),
  account: z.object({ iban: z.string(), bic: z.string(), holder: z.string() }),
  term: z.string(),
});
type DirectorySchool = z.infer<typeof DirectorySchool>;

const DirectoryInvoice = z.object({
  invoiceId: z.string(),
  schoolId: z.string(),
  studentId: z.string(),
  term: z.string(),
  amountMinor: z.number().int().positive(),
  paidMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().min(1).max(35),
  status: z.enum(["OPEN", "PARTLY_PAID", "PAID"]),
});

const toSchoolDto = (s: DirectorySchool): SchoolDto => ({ id: s.id, name: s.name, city: s.city, country: s.country, currency: s.currency, simulated: true });
const toInvoiceDto = (i: z.infer<typeof DirectoryInvoice>): SchoolInvoiceDto => i;

/** The same answer for a wrong date, a missing one and a student ID nobody has: it says nothing about which. */
const notVerified = () =>
  new HttpProblem(422, "STUDENT_NOT_VERIFIED", "The school could not confirm this student: check the student ID and date of birth", { details: { field: "dateOfBirth" } });

/** Proof attempts (date of birth sent to a school) per user per hour, on top of the per-IP route limit. */
export const SCHOOL_PROOF_TRIES_PER_HOUR = 20;

async function directory<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let res: unknown;
  try {
    res = await mockWorld(body === undefined ? "GET" : "POST", path, body);
  } catch (err) {
    if (err instanceof MockWorldError && err.status === 404) throw notFound("School");
    if (err instanceof MockWorldError && err.status === 422) throw new HttpProblem(422, "STUDENT_ID_INVALID", "A student ID is 4 to 20 letters, digits or dashes", { details: { field: "studentId" } });
    if (err instanceof MockWorldError && err.status === 403) throw notVerified();
    if (err instanceof MockWorldError && err.status === 429) {
      throw new HttpProblem(429, "RATE_LIMITED", "Too many tries for this student; try again in 15 minutes", { reasonCodes: ["RATE_LIMITED"] });
    }
    throw new HttpProblem(503, "SCHOOL_DIRECTORY_UNAVAILABLE", "The school directory is not answering; try again shortly");
  }
  const parsed = schema.safeParse(res);
  if (!parsed.success) throw new HttpProblem(502, "SCHOOL_DIRECTORY_INVALID", "The school directory sent something unexpected");
  return parsed.data;
}

export async function listSchools(q: string): Promise<SchoolDto[]> {
  const r = await directory(`/schools?q=${encodeURIComponent(q.slice(0, 60))}`, z.object({ schools: z.array(DirectorySchool) }));
  return r.schools.map(toSchoolDto);
}

/**
 * The school and this student's invoices. With `dateOfBirth` the school's portal confirms the student first (POST);
 * without it Kassa reads as itself (signed GET), which only a student it may already read can use (see top).
 */
async function schoolWithInvoices(schoolId: string, studentId: string, dateOfBirth?: string) {
  const id = encodeURIComponent(schoolId);
  const schema = z.object({ school: DirectorySchool, invoices: z.array(DirectoryInvoice) });
  const r =
    dateOfBirth === undefined
      ? await directory(`/schools/${id}/invoices?studentId=${encodeURIComponent(studentId)}`, schema)
      : await directory(`/schools/${id}/invoices`, schema, { studentId, dateOfBirth });
  // Only this student's invoices, in the school's own currency (what the recipient will be paid in).
  return { school: r.school, invoices: r.invoices.filter((i) => i.studentId === studentId && i.currency === r.school.currency) };
}

/** The user's tuition recipient for this school and student: from the directory, or added by hand with its account. */
async function existingPayee(userId: string, school: DirectorySchool, studentId: string) {
  const rows = await getDb()
    .select()
    .from(payees)
    .where(and(eq(payees.userId, userId), eq(payees.kind, "UNIVERSITY"), isNull(payees.archivedAt)));
  const hash = accountHash(school.account.iban);
  return rows.find((p) => {
    const d = readDetails(p);
    if (d?.category !== "TUITION" || d.studentId.toUpperCase() !== studentId) return false;
    return d.portalSchoolId === school.id || (!d.portalSchoolId && p.accountHash === hash && p.currency === school.currency);
  });
}

/**
 * Judge build: every reviewer has a private copy of a seeded persona with its own student ID (auth/demoClaim.ts
 * `ownSchoolIdentifiers`). A seeded student ID typed in "Find your school" (the portal's example, the demo script)
 * means the copy's own, so no copy can see or pay another's invoice through it.
 */
async function ownStudentId(userId: string, studentId: string): Promise<{ studentId: string; own: boolean }> {
  const id = studentId.trim().toUpperCase();
  const seed = await loadSeedData();
  const seededIds = [seed, ...(seed.personas ?? [])].flatMap((u) => u.payees.flatMap((p) => (p.details?.category === "TUITION" ? [p.details.studentId.toUpperCase()] : [])));
  if (judgeModeActive()) {
    if (seededIds.includes(id)) return { studentId: judgeCopyStudentId(id, userId), own: true };
    if (seededIds.some((s) => judgeCopyStudentId(s, userId) === id)) return { studentId: id, own: true };
  }
  // Another reviewer's copy: it has the seeded student's date of birth (which the demo script prints), so it is
  // refused outright, the same way as a wrong date.
  if (seededIds.some((s) => judgeCopySuffixOf(id, s))) throw notVerified();
  return { studentId, own: false };
}

/** The student's invoices once the school confirmed them (or the judge copy's own, which needs no confirmation). */
async function confirmedStudent(userId: string, schoolId: string, studentIdRaw: string, dateOfBirth: string | undefined) {
  const { studentId, own } = await ownStudentId(userId, studentIdRaw);
  if (own) return { studentId, ...(await schoolWithInvoices(schoolId, studentId)) };
  if (!dateOfBirth) throw notVerified();
  const hit = await incrCounter("budget:school-proof", userId, 3_600_000);
  if (hit.current > SCHOOL_PROOF_TRIES_PER_HOUR) {
    const minutes = Math.max(1, Math.ceil(hit.ttl / 60_000));
    throw new HttpProblem(429, "RATE_LIMITED", `Too many tries; try again in ${minutes} minutes`, { reasonCodes: ["RATE_LIMITED"] });
  }
  return { studentId, ...(await schoolWithInvoices(schoolId, studentId, dateOfBirth)) };
}

export async function lookup(userId: string, schoolId: string, studentIdRaw: string, dateOfBirth?: string): Promise<SchoolLookupResponse> {
  const { studentId, school, invoices } = await confirmedStudent(userId, schoolId, studentIdRaw, dateOfBirth);
  return { school: toSchoolDto(school), invoices: invoices.map(toInvoiceDto), existingPayeeId: (await existingPayee(userId, school, studentId))?.id ?? null };
}

/** A bill for each invoice still open, unless one with its reference already exists for this recipient. */
async function importInvoices(userId: string, payeeId: string, invoices: z.infer<typeof DirectoryInvoice>[]): Promise<string[]> {
  const db = getDb();
  const have = new Set(
    (await db.select({ reference: obligations.reference }).from(obligations).where(and(eq(obligations.userId, userId), eq(obligations.payeeId, payeeId)))).map((o) => o.reference),
  );
  const today = isoDate(clock.now());
  const created: string[] = [];
  for (const i of invoices) {
    const due = i.amountMinor - i.paidMinor;
    if (i.status === "PAID" || due <= 0 || have.has(i.reference)) continue;
    const o = await createObligation(userId, { payeeId, amountMinor: due, currency: i.currency, dueDate: i.dueDate < today ? today : i.dueDate, recurrence: "ONCE", reference: i.reference });
    have.add(i.reference);
    created.push(o.id);
  }
  return created;
}

export async function linkSchool(userId: string, schoolId: string, studentIdRaw: string, dateOfBirth?: string): Promise<SchoolLinkResponse> {
  const { studentId, school, invoices } = await confirmedStudent(userId, schoolId, studentIdRaw, dateOfBirth);
  let payee = await existingPayee(userId, school, studentId);
  if (payee) {
    const d = readDetails(payee);
    if (d?.category === "TUITION" && d.portalSchoolId !== school.id) {
      // Added by hand to the same account: remember the school so its portal and invoices are one tap away.
      payee = await updatePayeeDetails(userId, payee.id, { ...d, term: d.term ?? school.term }, { portalSchoolId: school.id });
    }
  } else {
    const details: RecipientDetails = { category: "TUITION", studentId, term: invoices[0]?.term ?? school.term, portalSchoolId: school.id };
    payee = await createPayee(userId, { name: school.name, kind: "UNIVERSITY", account: school.account.iban, country: school.country, currency: school.currency, details, source: "school-directory" });
  }
  const createdObligationIds = await importInvoices(userId, payee.id, invoices);
  await ledger.append("SCHOOL_LINKED", { userId, payeeId: payee.id, schoolId: school.id, invoices: invoices.length, billsCreated: createdObligationIds.length });
  return { payee: toPayeeDto(payee), invoices: invoices.map(toInvoiceDto), createdObligationIds };
}

export async function refreshInvoices(userId: string, payeeId: string): Promise<SchoolLinkResponse> {
  const p = (await getDb().select().from(payees).where(and(eq(payees.id, payeeId), eq(payees.userId, userId), isNull(payees.archivedAt))))[0];
  if (!p) throw notFound("Recipient");
  const d = readDetails(p);
  if (d?.category !== "TUITION" || !d.portalSchoolId) throw conflict("NOT_FROM_SCHOOL_DIRECTORY", "This recipient was not added from the school directory");
  const { school, invoices } = await schoolWithInvoices(d.portalSchoolId, d.studentId.toUpperCase());
  // The directory's account must still be the one this recipient pays: a school that changed banks is a new recipient (I7).
  if (accountHash(school.account.iban) !== p.accountHash || school.currency !== p.currency) {
    throw conflict("SCHOOL_ACCOUNT_CHANGED", `${school.name} now asks to be paid to a different account; add the school again to make a new recipient`);
  }
  const createdObligationIds = await importInvoices(userId, p.id, invoices);
  return { payee: toPayeeDto(p), invoices: invoices.map(toInvoiceDto), createdObligationIds };
}

const SchoolEvent = z.object({
  eventId: z.string().min(1).max(80),
  type: z.literal("invoice.payment_received"),
  schoolId: z.string().max(64),
  schoolName: z.string().max(140),
  studentId: z.string().max(20),
  invoiceId: z.string().max(80),
  reference: z.string().max(35),
  amountMinor: z.number().int().positive(),
  paidMinor: z.number().int().nonnegative(),
  invoiceAmountMinor: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.enum(["PARTLY_PAID", "PAID"]),
  transferId: z.number().int().positive(),
  customerTransactionId: z.string().uuid(),
  receivedAt: z.string(),
});

export type SchoolReceipt = { schoolId: string; invoiceId: string; status: "PARTLY_PAID" | "PAID"; paidMinor: number; invoiceAmountMinor: number; receivedAt: string };

/**
 * The school's portal booked one of our bank transfers against an invoice. Matched by the transfer (proposal id and
 * rail reference), so a school can only speak about a payment Kassa actually sent; the amount must be what was sent.
 */
export async function onSchoolWebhook(body: unknown): Promise<Record<string, unknown>> {
  const parsed = SchoolEvent.safeParse(body);
  if (!parsed.success) throw conflict("WEBHOOK_REJECTED", "Malformed school event");
  const ev = parsed.data;
  const db = getDb();
  const p = (await db.select().from(payments).where(and(eq(payments.proposalId, ev.customerTransactionId), eq(payments.rail, "BANK_TRANSFER"))))[0];
  if (!p || p.railRef !== String(ev.transferId)) {
    await ledger.append("WEBHOOK_UNMATCHED", { kind: "school", type: ev.type, schoolId: ev.schoolId, transferId: ev.transferId });
    return { ok: true, matched: false };
  }
  // The payment's amount is what the recipient was sent, in the recipient's currency.
  if (p.currency !== ev.currency || p.amountMinor !== ev.amountMinor) {
    await ledger.append("WEBHOOK_REJECTED", { kind: "school", userId: p.userId, paymentId: p.id, reason: "AMOUNT_MISMATCH" });
    throw conflict("WEBHOOK_REJECTED", "The school reports a different amount than was sent");
  }
  const prev = (p.details as { schoolReceipt?: SchoolReceipt }).schoolReceipt;
  if (prev && prev.invoiceId === ev.invoiceId && prev.status === ev.status && prev.paidMinor === ev.paidMinor) return { ok: true, matched: true, changed: false };
  const receipt: SchoolReceipt = { schoolId: ev.schoolId, invoiceId: ev.invoiceId, status: ev.status, paidMinor: ev.paidMinor, invoiceAmountMinor: ev.invoiceAmountMinor, receivedAt: ev.receivedAt };
  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({ details: { ...p.details, schoolReceipt: receipt }, updatedAt: clock.now() })
      .where(eq(payments.id, p.id));
    await ledger.append("SCHOOL_PAYMENT_RECEIVED", { userId: p.userId, paymentId: p.id, schoolId: ev.schoolId, invoiceId: ev.invoiceId, status: ev.status, amountMinor: ev.amountMinor, paidMinor: ev.paidMinor, invoiceAmountMinor: ev.invoiceAmountMinor, currency: ev.currency }, tx);
    await notify(
      p.userId,
      {
        kind: "SCHOOL_PAYMENT_RECEIVED",
        title: ev.status === "PAID" ? `${ev.schoolName} received your tuition` : `${ev.schoolName} received part of your tuition`,
        body: ev.status === "PAID" ? `Invoice ${ev.invoiceId} is paid in full.` : `Invoice ${ev.invoiceId} still has some left to pay.`,
        data: { paymentId: p.id, schoolId: ev.schoolId, invoiceId: ev.invoiceId, status: ev.status },
      },
      tx,
    );
  });
  return { ok: true, matched: true, changed: true };
}
