import { createHash, randomUUID } from "node:crypto";

import { buildIban, buildRfReference, normalizeIban, toMinor } from "@kassa/shared";

import { ACCOUNTS, LI_WEI_TUITION_REFERENCE, TUITION_REFERENCE } from "../../../../fixtures/seed-data.ts";
import type { Recipient, Transfer } from "../bank/bank.ts";
import type { Clock } from "../clock.ts";
import { HttpError } from "../errors.ts";
import type { WebhookSink } from "../webhooks.ts";

/*
 * (added 2026-10-15) School payment portals (simulated third-party systems, fictitious schools). Each school has the
 * bank account it is paid to and, per student ID, an open tuition invoice with an ISO 11649 reference. Kassa reads
 * the directory and a student's invoices; when the mock bank pays out a transfer to the school's account whose
 * reference contains an invoice's reference, the portal books it against that invoice and tells Kassa with a signed
 * "school" webhook (invoice.payment_received). A payment without a known reference stays unmatched, as at a real
 * bursar's office, and is shown on the portal for manual matching.
 *
 * In production this is a partner such as Flywire or Convera, which identify payments the same way.
 */

export interface School {
  id: string;
  /** Short code used in invoice ids and references. */
  code: string;
  name: string;
  city: string;
  country: string;
  currency: string;
  iban: string;
  bic: string;
  term: string;
  /** Generated invoices fall in [min, max] (major units, step), deterministic per student ID. */
  fee: { min: number; max: number; step: number };
}

export const SCHOOLS: Record<string, School> = {
  budapest: {
    id: "budapest",
    code: "BUD",
    // The same school (name, account) as Dana's and Li Wei's seeded tuition recipient.
    name: "University in Budapest",
    city: "Budapest",
    country: "HU",
    currency: "EUR",
    iban: ACCOUNTS.university,
    bic: "RVUBHUHBXXX",
    term: "Fall 2026",
    fee: { min: 2000, max: 3200, step: 50 },
  },
  debrecen: {
    id: "debrecen",
    code: "DEB",
    name: "Medical University in Debrecen",
    city: "Debrecen",
    country: "HU",
    currency: "HUF",
    iban: buildIban("HU", "117730161111101800000000"),
    bic: "OTPVHUHBXXX",
    term: "Fall 2026",
    fee: { min: 600_000, max: 950_000, step: 5_000 },
  },
  vienna: {
    id: "vienna",
    code: "VIE",
    name: "Music Academy in Vienna",
    city: "Vienna",
    country: "AT",
    currency: "EUR",
    iban: buildIban("AT", "1200010012345678"),
    bic: "BKAUATWWXXX",
    term: "Winter 2026",
    fee: { min: 1500, max: 2500, step: 50 },
  },
  almaty: {
    id: "almaty",
    code: "ALA",
    name: "Business School in Almaty",
    city: "Almaty",
    country: "KZ",
    currency: "KZT",
    iban: buildIban("KZ", "125KZT5004100100"),
    bic: "KCJBKZKXXXX",
    term: "Fall 2026",
    fee: { min: 900_000, max: 1_500_000, step: 10_000 },
  },
};

/** Invoices known before anyone looks them up: the seeded students' tuition (same amounts as the seeded bills). */
const SEEDED: { schoolId: string; studentId: string; amountMinor: number; dueDate: string; reference: string }[] = [
  { schoolId: "budapest", studentId: "KZ26-0417", amountMinor: 240_000, dueDate: "2026-10-31", reference: TUITION_REFERENCE },
  { schoolId: "budapest", studentId: "CN26-0331", amountMinor: 320_000, dueDate: "2026-11-10", reference: LI_WEI_TUITION_REFERENCE },
];

export interface SchoolPayment {
  transferId: number;
  amountMinor: number;
  currency: string;
  reference: string;
  receivedAt: string;
}

export interface SchoolInvoice {
  invoiceId: string;
  schoolId: string;
  studentId: string;
  term: string;
  amountMinor: number;
  paidMinor: number;
  currency: string;
  dueDate: string;
  reference: string;
  status: "OPEN" | "PARTLY_PAID" | "PAID";
  payments: SchoolPayment[];
}

const compact = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export function resolveSchool(id: unknown): School {
  const key = typeof id === "string" ? id.toLowerCase() : "";
  const s = SCHOOLS[key];
  if (!s) throw new HttpError(404, "NOT_FOUND", "Unknown school");
  return s;
}

export function parseStudentId(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!/^[A-Z0-9-]{4,20}$/.test(s)) throw new HttpError(422, "STUDENT_ID_INVALID", "A student ID is 4 to 20 letters, digits or dashes");
  return s;
}

export function searchSchools(q: string): School[] {
  const needle = q.trim().toLowerCase();
  const all = Object.values(SCHOOLS);
  if (!needle) return all;
  return all.filter((s) => `${s.name} ${s.city} ${s.country}`.toLowerCase().includes(needle));
}

export class SchoolBook {
  /** key `${schoolId}:${studentId}` */
  private readonly invoices = new Map<string, SchoolInvoice>();
  private readonly unmatched: (SchoolPayment & { schoolId: string })[] = [];
  private readonly seenTransfers = new Set<number>();

  constructor(private readonly deps: { clock: Clock; webhooks: WebhookSink }) {
    this.seed();
  }

  reset(): void {
    this.invoices.clear();
    this.unmatched.length = 0;
    this.seenTransfers.clear();
    this.seed();
  }

  private seed(): void {
    for (const s of SEEDED) {
      const school = SCHOOLS[s.schoolId]!;
      this.invoices.set(`${s.schoolId}:${s.studentId}`, {
        invoiceId: `INV-${school.code}-${s.studentId}`,
        schoolId: s.schoolId,
        studentId: s.studentId,
        term: school.term,
        amountMinor: s.amountMinor,
        paidMinor: 0,
        currency: school.currency,
        dueDate: s.dueDate,
        reference: s.reference,
        status: "OPEN",
        payments: [],
      });
    }
  }

  /** The student's invoices at this school. Any well-formed student ID has one (generated once, deterministically). */
  async invoicesFor(school: School, studentId: string): Promise<SchoolInvoice[]> {
    const key = `${school.id}:${studentId}`;
    let inv = this.invoices.get(key);
    if (!inv) {
      const h = createHash("sha256").update(key).digest();
      const steps = Math.floor((school.fee.max - school.fee.min) / school.fee.step) + 1;
      const amountMinor = toMinor(String(school.fee.min + (h.readUInt32BE(0) % steps) * school.fee.step), school.currency);
      const digits = String(h.readUInt32BE(4) % 100_000).padStart(5, "0");
      const due = new Date((await this.deps.clock.now()).getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
      inv = {
        invoiceId: `INV-${school.code}-${studentId}`,
        schoolId: school.id,
        studentId,
        term: school.term,
        amountMinor,
        paidMinor: 0,
        currency: school.currency,
        dueDate: due,
        reference: buildRfReference(`${school.code}26${digits}`),
        status: "OPEN",
        payments: [],
      };
      this.invoices.set(key, inv);
    }
    return [inv];
  }

  unmatchedFor(schoolId: string): (SchoolPayment & { schoolId: string })[] {
    return this.unmatched.filter((p) => p.schoolId === schoolId);
  }

  /** Bank listener: a transfer paid out to a school's account is booked against the invoice its reference names. */
  onPayout(t: Transfer, account: Recipient | undefined): void {
    if (!account || account.type !== "iban" || this.seenTransfers.has(t.id)) return;
    const iban = normalizeIban(String((account.details as { iban?: string }).iban ?? ""));
    const school = Object.values(SCHOOLS).find((s) => s.iban === iban);
    if (!school) return;
    this.seenTransfers.add(t.id);
    const receivedAt = t.history.at(-1)?.at ?? new Date().toISOString();
    const payment: SchoolPayment = { transferId: t.id, amountMinor: t.targetAmountMinor, currency: t.targetCurrency, reference: t.reference, receivedAt };
    const ref = compact(t.reference);
    const inv = [...this.invoices.values()].find((i) => i.schoolId === school.id && i.currency === t.targetCurrency && ref.includes(compact(i.reference)));
    if (!inv) {
      this.unmatched.push({ ...payment, schoolId: school.id });
      return;
    }
    inv.payments.push(payment);
    inv.paidMinor += payment.amountMinor;
    inv.status = inv.paidMinor >= inv.amountMinor ? "PAID" : "PARTLY_PAID";
    this.deps.webhooks.send("school", {
      eventId: randomUUID(),
      type: "invoice.payment_received",
      schoolId: school.id,
      schoolName: school.name,
      studentId: inv.studentId,
      invoiceId: inv.invoiceId,
      reference: inv.reference,
      amountMinor: payment.amountMinor,
      paidMinor: inv.paidMinor,
      invoiceAmountMinor: inv.amountMinor,
      currency: inv.currency,
      status: inv.status,
      transferId: t.id,
      customerTransactionId: t.customerTransactionId,
      receivedAt,
      simulated: true,
    });
  }
}
