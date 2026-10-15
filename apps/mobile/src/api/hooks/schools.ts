/** "Find your school": the school directory, a student's invoice, and adding the school with its bill. */
import {
  SchoolLinkResponse,
  SchoolLookupResponse,
  SchoolsResponse,
  SchoolStudentRequest,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";

export function useSchools(q: string, enabled = true) {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  const query = q.trim();
  return useQuery({
    queryKey: keys.schools(query),
    queryFn: ({ signal }) =>
      api.request(`/schools?q=${encodeURIComponent(query)}`, { schema: SchoolsResponse, signal }),
    enabled: authed && enabled,
    staleTime: 60_000,
  });
}

/** What adding this school would do (writes nothing). */
export function useSchoolLookup() {
  return useMutation({
    mutationFn: ({ schoolId, studentId }: { schoolId: string; studentId: string }) =>
      api.request(`/schools/${encodeURIComponent(schoolId)}/lookup`, {
        json: SchoolStudentRequest.parse({ studentId }),
        schema: SchoolLookupResponse,
      }),
  });
}

function useInvalidateBills() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.payees }),
      qc.invalidateQueries({ queryKey: keys.obligations }),
      qc.invalidateQueries({ queryKey: keys.forecast }),
    ]);
}

/** Add the school as a tuition recipient (it cools for 24 h) and its open invoice as a bill. */
export function useLinkSchool() {
  const invalidate = useInvalidateBills();
  return useMutation({
    mutationFn: ({ schoolId, studentId }: { schoolId: string; studentId: string }) =>
      api.request(`/schools/${encodeURIComponent(schoolId)}/link`, {
        json: SchoolStudentRequest.parse({ studentId }),
        schema: SchoolLinkResponse,
      }),
    onSettled: invalidate,
  });
}

/** Import new invoices for a recipient added from the directory. */
export function useRefreshSchoolInvoices() {
  const invalidate = useInvalidateBills();
  return useMutation({
    mutationFn: (payeeId: string) =>
      api.request(`/payees/${encodeURIComponent(payeeId)}/school-invoices`, {
        method: "POST",
        schema: SchoolLinkResponse,
      }),
    onSettled: invalidate,
  });
}
