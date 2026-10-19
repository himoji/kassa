import { createHash } from "node:crypto";

import { buildRfReference } from "@kassa/shared";

/*
 * (added 2026-10-18) Judge build: every sign-in gets a private copy of a seeded persona (apps/api/src/modules/auth/
 * demoClaim.ts). Identifiers an outside system keeps state under must not be shared between copies, or one reviewer's
 * payment shows up in another's world. The school portals are the one such system: an invoice is looked up by
 * student ID and matched to a payment by its reference. A copy therefore gets its own student ID (the seeded one plus
 * a suffix derived from the copy's user id) and its own invoice reference (the seeded reference's body plus the same
 * suffix). The mock world (apps/mock-world/src/school/schools.ts) recognises such an ID and opens the same invoice as
 * the seeded student's (amount, due date, term) under that reference, so nothing has to be registered and a cold
 * start changes nothing.
 */

/** 6 characters, A-Z0-9, from the copy's user id. */
export function judgeCopySuffix(userId: string): string {
  return createHash("sha256").update(`kassa-judge-copy:v1:${userId.toLowerCase()}`).digest("hex").slice(0, 6).toUpperCase();
}

/** The copy's student ID: `KZ26-0417` → `KZ26-0417-1A2B3C` (fits the portals' 4–20 characters). */
export function judgeCopyStudentId(seededStudentId: string, userId: string): string {
  return `${seededStudentId}-${judgeCopySuffix(userId)}`;
}

/** The suffix of a copy's student ID made from `seededStudentId`, or null. */
export function judgeCopySuffixOf(studentId: string, seededStudentId: string): string | null {
  const m = new RegExp(`^${seededStudentId.replace(/[^A-Z0-9-]/g, "")}-([0-9A-F]{6})$`).exec(studentId.toUpperCase());
  return m ? m[1]! : null;
}

/** The copy's ISO 11649 reference: `RF39RUB2026F04217` → RF + check digits + `RUB2026F04217` + suffix. */
export function judgeCopyReference(seededReference: string, suffix: string): string {
  const body = seededReference.replace(/\s+/g, "").toUpperCase().replace(/^RF\d{2}/, "");
  return buildRfReference(`${body}${suffix}`.slice(-21));
}
