import { KycCheckDto, KycStartRequest, KycStatusResponse } from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";

/** GET /kyc: the user's identity check standing and the threshold above which it is needed. */
export function useKyc() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.kyc,
    queryFn: ({ signal }) => api.request("/kyc", { schema: KycStatusResponse, signal }),
    enabled: authed,
  });
}

/** POST /kyc/start: run the simulated identity check with a fictitious document. */
export function useStartKyc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: KycStartRequest) =>
      api.request("/kyc/start", { json: KycStartRequest.parse(body), schema: KycCheckDto }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.kyc }),
  });
}
