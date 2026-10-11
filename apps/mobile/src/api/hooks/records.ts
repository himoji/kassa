import {
  CreditRecordExportResponse,
  CreditRecordVerifyResponse,
  HandoffView,
  type CreditRecordExportRequest,
} from "@kassa/shared";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "../client";
import { keys } from "../keys";

export function useExportCreditRecord() {
  return useMutation({
    mutationFn: (body: CreditRecordExportRequest) =>
      api.request("/credit-record/export", { json: body, schema: CreditRecordExportResponse }),
  });
}

/** Public, no session (spec §8 GET /public/verify/:id). */
export function useVerifyRecord(id: string) {
  return useQuery({
    queryKey: keys.verify(id),
    queryFn: ({ signal }) =>
      api.request(`/public/verify/${encodeURIComponent(id)}`, {
        schema: CreditRecordVerifyResponse,
        auth: false,
        signal,
      }),
    enabled: id.length > 0,
  });
}

export function useHandoff(paymentId: string) {
  return useQuery({
    queryKey: keys.handoff(paymentId),
    queryFn: ({ signal }) =>
      api.request(`/handoff/${encodeURIComponent(paymentId)}`, { schema: HandoffView, signal }),
    enabled: paymentId.length > 0,
    refetchInterval: 10_000,
  });
}
