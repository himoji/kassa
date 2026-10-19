import { type RecipientDetails, schoolPortalAccess } from "@kassa/shared";

import { env } from "../../env.ts";
import { clock } from "../clock/index.ts";

/** How long a portal link from Kassa signs the student in (from the start of the current hour, wall time). */
const PORTAL_ACCESS_SECONDS = 24 * 3600;

/**
 * The school portal page for a tuition recipient added from the directory (null for any other recipient). The school
 * confirmed this student when the recipient was linked (schools/service.ts), so the link signs the student in
 * (`access`, @kassa/shared schoolPortalAccess) for a day; after that the portal asks for the date of birth. Only the
 * recipient's owner is shown it.
 */
export function portalLinkFor(details: RecipientDetails | null): string | null {
  if (details?.category !== "TUITION" || !details.portalSchoolId) return null;
  const e = env();
  const base = e.MOCK_PUBLIC_URL.replace(/\/$/, "");
  const studentId = details.studentId.toUpperCase();
  // Same link for an hour (stable in lists and caches), always valid for at least 23 hours.
  const hour = Math.floor(clock.realNowMs() / 3_600_000) * 3600;
  const access = schoolPortalAccess(e.MOCK_HMAC_SECRET, details.portalSchoolId, studentId, hour + PORTAL_ACCESS_SECONDS);
  return `${base}/mock/schools/${encodeURIComponent(details.portalSchoolId)}/portal?studentId=${encodeURIComponent(studentId)}&access=${access}`;
}
