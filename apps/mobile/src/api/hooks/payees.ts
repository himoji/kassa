import {
  CreatePayeeRequest,
  MandateDto,
  MandateOptionsResponse,
  MandatesResponse,
  PayeeDto,
  PayeesResponse,
  type MandateOptionsRequest,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { signWithPasskey } from "@/lib/passkeys";
import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";

export function usePayees() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.payees,
    queryFn: ({ signal }) => api.request("/payees", { schema: PayeesResponse, signal }),
    enabled: authed,
  });
}

/** POST /payees - always created COOLING (I7). */
export function useCreatePayee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePayeeRequest) =>
      api.request("/payees", { json: CreatePayeeRequest.parse(body), schema: PayeeDto }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.payees }),
  });
}

/** Simulated bank verification callback (demo). */
export function useSimulatePayeeVerification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request(`/payees/${encodeURIComponent(id)}/verify-callback`, { json: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.payees }),
  });
}

export function useMandates() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.mandates,
    queryFn: ({ signal }) => api.request("/mandates", { schema: MandatesResponse, signal }),
    enabled: authed,
  });
}

/**
 * Create a mandate: the server builds and normalises the core and returns WebAuthn options whose
 * challenge is mandateHash(core); the passkey signs exactly that (spec §7 T1). It becomes active
 * after 24 h (I8: widening is slow).
 */
export function useCreateMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (request: MandateOptionsRequest) => {
      const options = await api.request("/mandates/options", {
        json: request,
        schema: MandateOptionsResponse,
      });
      if (options.webauthnOptions.challenge !== options.mandateHash) {
        throw new Error("Mandate challenge does not match the mandate hash");
      }
      const assertion = await signWithPasskey(options.webauthnOptions);
      return api.request("/mandates", {
        json: { core: options.core, assertion },
        schema: MandateDto,
      });
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.mandates }),
        qc.invalidateQueries({ queryKey: keys.ruleChanges }),
      ]),
  });
}

/** Revoke is instant (I8: tightening), no passkey. */
export function useRevokeMandate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request(`/mandates/${encodeURIComponent(id)}/revoke`, { json: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.mandates }),
  });
}
