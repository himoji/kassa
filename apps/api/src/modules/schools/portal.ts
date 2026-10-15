import type { RecipientDetails } from "@kassa/shared";

import { env } from "../../env.ts";

/** The school portal page for a tuition recipient added from the directory (null for any other recipient). */
export function portalLinkFor(details: RecipientDetails | null): string | null {
  if (details?.category !== "TUITION" || !details.portalSchoolId) return null;
  const base = env().MOCK_PUBLIC_URL.replace(/\/$/, "");
  return `${base}/mock/schools/${encodeURIComponent(details.portalSchoolId)}/portal?studentId=${encodeURIComponent(details.studentId)}`;
}
