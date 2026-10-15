/*
 * Recipients (the app's name for payees): who or what a payment goes to, grouped into five categories that each ask
 * for their own details. The category is derived from the payee kind, so the rules engine, rails and mandates keep
 * working on `kind`; the details are what the person reads and what goes into the payment reference.
 *
 *   PEOPLE   family, friends, someone you pay wages to   PERSON, OWN_ACCOUNT
 *   TUITION  a school or university                      UNIVERSITY
 *   RENT     a landlord or dorm                          LANDLORD
 *   BILLS    utilities, phone, internet, insurance       BILLER, INSURER
 *   SHOPS    a shop, café or supplier                    MERCHANT, SUPPLIER
 *
 * Details never change where money goes (that is the account, and a changed account is a new payee that cools for
 * 24 h, I7), so they can be edited at any time.
 */
import { z } from "zod";

import type { PayeeKind } from "./enums.ts";

export const RecipientCategory = z.enum(["PEOPLE", "TUITION", "RENT", "BILLS", "SHOPS"]);
export type RecipientCategory = z.infer<typeof RecipientCategory>;

export function categoryOfKind(kind: PayeeKind): RecipientCategory {
  switch (kind) {
    case "UNIVERSITY":
      return "TUITION";
    case "LANDLORD":
      return "RENT";
    case "BILLER":
    case "INSURER":
      return "BILLS";
    case "MERCHANT":
    case "SUPPLIER":
      return "SHOPS";
    default:
      return "PEOPLE";
  }
}

/** The kind a new recipient of `category` gets. Bills split: insurance keeps INSURER (its own budget category). */
export function kindForCategory(category: RecipientCategory, details?: RecipientDetails | null): PayeeKind {
  switch (category) {
    case "TUITION":
      return "UNIVERSITY";
    case "RENT":
      return "LANDLORD";
    case "BILLS":
      return details?.category === "BILLS" && details.billType === "INSURANCE" ? "INSURER" : "BILLER";
    case "SHOPS":
      return "MERCHANT";
    default:
      return "PERSON";
  }
}

export const Relationship = z.enum(["FAMILY", "FRIEND", "EMPLOYEE", "OTHER"]);
export type Relationship = z.infer<typeof Relationship>;

export const BillType = z.enum(["UTILITIES", "PHONE", "INTERNET", "INSURANCE", "OTHER"]);
export type BillType = z.infer<typeof BillType>;

const text = (max: number) => z.string().trim().min(1).max(max);
/** Kazakhstan KNP payment purpose code (National Bank classifier): 3 digits, e.g. 311 salary, 119 own transfers. */
export const KnpCode = z.string().regex(/^\d{3}$/, "KNP is 3 digits");
const HttpsUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https:\/\//i.test(u), "Use an https:// link");

export const PeopleDetails = z
  .object({
    category: z.literal("PEOPLE"),
    relationship: Relationship,
    /** Shown on their statement, e.g. "Monthly support" or "Wages for October". */
    note: text(140).optional(),
    purposeCode: KnpCode.optional(),
  })
  .strict();

export const TuitionDetails = z
  .object({
    category: z.literal("TUITION"),
    /** The ID the school's bursar matches payments with. */
    studentId: text(40),
    /** The school's payment portal (Flywire, Convera, the bursar's page). */
    portalUrl: HttpsUrl.optional(),
    term: text(40).optional(),
    /** (phase 3) The school's id in a payment portal directory, when added from it. */
    portalSchoolId: text(64).optional(),
  })
  .strict();

export const RentDetails = z
  .object({
    category: z.literal("RENT"),
    /** Contract number, room or unit: what the landlord expects in the reference. */
    reference: text(60).optional(),
    dueDay: z.number().int().min(1).max(28).optional(),
  })
  .strict();

export const BillsDetails = z
  .object({
    category: z.literal("BILLS"),
    billType: BillType,
    /** Customer or account number at the biller. */
    customerNumber: text(40),
    /** A reference in the format the biller asks for, when it is not just the customer number. */
    reference: text(60).optional(),
  })
  .strict();

export const ShopsDetails = z
  .object({
    category: z.literal("SHOPS"),
    note: text(140).optional(),
  })
  .strict();

export const RecipientDetails = z.discriminatedUnion("category", [PeopleDetails, TuitionDetails, RentDetails, BillsDetails, ShopsDetails]);
export type RecipientDetails = z.infer<typeof RecipientDetails>;

/** True when `details` belongs to the recipient's category (details of another category are refused). */
export function detailsFitKind(kind: PayeeKind, details: RecipientDetails): boolean {
  if (details.category !== categoryOfKind(kind)) return false;
  // An insurer is a bill of type INSURANCE and vice versa, so the budget category stays right.
  if (details.category === "BILLS") return (kind === "INSURER") === (details.billType === "INSURANCE");
  return true;
}

/** The payment reference a recipient's details suggest ("" when none), e.g. "Tuition S1234567 Fall 2026". */
export function suggestedReference(details: RecipientDetails | null | undefined): string {
  if (!details) return "";
  switch (details.category) {
    case "TUITION":
      return ["Tuition", details.studentId, details.term].filter(Boolean).join(" ");
    case "RENT":
      return details.reference ? `Rent ${details.reference}` : "Rent";
    case "BILLS":
      return details.reference ?? details.customerNumber;
    case "PEOPLE":
      return details.note ?? "";
    default:
      return details.note ?? "";
  }
}

/** Budget category for bills to this recipient (obligations and orders), from its kind and details. */
export function budgetCategoryFor(kind: PayeeKind, details: RecipientDetails | null | undefined): string {
  if (details?.category === "PEOPLE" && details.relationship === "EMPLOYEE") return "wages";
  if (details?.category === "BILLS") {
    return details.billType === "INSURANCE" ? "insurance" : details.billType === "PHONE" ? "phone" : "utilities";
  }
  switch (kind) {
    case "LANDLORD":
      return "rent";
    case "UNIVERSITY":
      return "tuition";
    case "INSURER":
      return "insurance";
    case "BILLER":
      return "utilities";
    case "MERCHANT":
      return "shopping";
    case "SUPPLIER":
      return "supplies";
    default:
      return "transfers";
  }
}
