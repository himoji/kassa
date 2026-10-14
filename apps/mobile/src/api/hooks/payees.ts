import {
  CreateObligationRequest,
  CreatePayeeRequest,
  MandateDto,
  MandateOptionsResponse,
  MandatesResponse,
  PayeeDto,
  PayeesResponse,
  UpdatePayeeRequest,
  type MandateOptionsRequest,
  type RecipientDetails,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";
import { withPasskeyGate } from "../passkey-gate";
import { signPasskeyChallenge } from "../passkey-sign";

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

/** PATCH /payees/:id - details only (student ID, customer number…); no new cooling period. */
export function useUpdatePayeeDetails(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (details: RecipientDetails | null) =>
      api.request(`/payees/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: UpdatePayeeRequest.parse({ details }),
        schema: PayeeDto,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.payees }),
  });
}

/** DELETE /payees/:id - hidden and never payable again; refused (409 PAYEE_HAS_BILLS) while it has bills. */
export function useRemovePayee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.request(`/payees/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.payees }),
  });
}

/** POST /obligations - a schedule (rent, a bill, wages) the scheduler proposes when due. */
export function useCreateObligation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateObligationRequest) =>
      api.request("/obligations", { json: CreateObligationRequest.parse(body) }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.obligations }),
        qc.invalidateQueries({ queryKey: keys.forecast }),
      ]),
  });
}

/** Simulated bank verification callback (demo). */
export function useSimulatePayeeVerification() {
  const qc = useQueryClient();
  return useMutation({
    // Passkey-gated (X3): 428 PASSKEY_REQUIRED with a challenge bound to this payee → sign, resend.
    mutationFn: (id: string) =>
      withPasskeyGate((proof) =>
        api.request(`/payees/${encodeURIComponent(id)}/verify-callback`, { json: { ...proof } })
      ),
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
      const assertion = await signPasskeyChallenge(options.webauthnOptions);
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
