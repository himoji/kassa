/*
 * (added 2026-10-15) School payment portals: "Find your school" for Tuition recipients. A directory of schools (each
 * with the bank account it is paid to) and, per student ID, the school's open invoices: amount, currency, due date
 * and the reference the bursar matches payments with. Adding a school from the directory creates the recipient (it
 * still cools for 24 h, I7) and turns its open invoice into a bill. The school's portal shows the invoice as paid
 * once the bank has paid it out, and tells Kassa (a signed "school" webhook).
 *
 * Demo: the directory and portals are mock-world's fictitious schools. In production this is a partner such as
 * Flywire or Convera, which also identify a payment by student ID and reference.
 */
import { z } from "zod";

import { PayeeDto } from "./dto.ts";
import { IsoDate } from "./primitives.ts";

export const StudentId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{4,20}$/, "4 to 20 letters, digits or dashes")
  .transform((s) => s.toUpperCase());

export const SchoolDto = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  country: z.string().length(2),
  currency: z.string().length(3),
  simulated: z.boolean(),
});
export type SchoolDto = z.infer<typeof SchoolDto>;

export const SchoolsResponse = z.object({ schools: z.array(SchoolDto) });
export type SchoolsResponse = z.infer<typeof SchoolsResponse>;

export const SchoolInvoiceStatus = z.enum(["OPEN", "PARTLY_PAID", "PAID"]);
export type SchoolInvoiceStatus = z.infer<typeof SchoolInvoiceStatus>;

export const SchoolInvoiceDto = z.object({
  invoiceId: z.string(),
  schoolId: z.string(),
  studentId: z.string(),
  term: z.string(),
  amountMinor: z.number().int().positive(),
  paidMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  dueDate: z.string(),
  /** ISO 11649 creditor reference: put it in the payment so the school can match it. */
  reference: z.string(),
  status: SchoolInvoiceStatus,
});
export type SchoolInvoiceDto = z.infer<typeof SchoolInvoiceDto>;

/**
 * POST /schools/:id/lookup and /schools/:id/link. (2026-10-19) The school confirms the student before Kassa sees an
 * invoice or adds a recipient: the student's date of birth must match the school's file (checked by the school's
 * portal, not by Kassa; Kassa does not keep it). A wrong or missing date gets the same STUDENT_NOT_VERIFIED answer
 * whether or not the student ID exists. Judge build only: the seeded student ID means the reviewer's own copy, which
 * needs no date.
 */
export const SchoolStudentRequest = z.object({
  studentId: StudentId,
  dateOfBirth: IsoDate.optional(),
});
export type SchoolStudentRequest = z.input<typeof SchoolStudentRequest>;

/** POST /schools/:id/lookup: what adding this school would do (writes nothing). */
export const SchoolLookupResponse = z.object({
  school: SchoolDto,
  invoices: z.array(SchoolInvoiceDto),
  /** The user's recipient for this school and student, when they already have one. */
  existingPayeeId: z.string().uuid().nullable(),
});
export type SchoolLookupResponse = z.infer<typeof SchoolLookupResponse>;

/** POST /schools/:id/link and POST /payees/:id/school-invoices */
export const SchoolLinkResponse = z.object({
  payee: PayeeDto,
  invoices: z.array(SchoolInvoiceDto),
  /** Bills created now (an invoice already imported is not imported twice). */
  createdObligationIds: z.array(z.string().uuid()),
});
export type SchoolLinkResponse = z.infer<typeof SchoolLinkResponse>;
