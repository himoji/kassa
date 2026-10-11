/**
 * Orders (spec §7 T2 flow). Approval signs ONLY the server's canonical order: before the passkey
 * prompt the app recomputes `orderHash(canonicalOrder)` locally (RFC 8785 JCS + SHA-256, same
 * code as the server) and refuses to sign if it differs from the server's orderHash or from the
 * WebAuthn challenge. A tampered or mismatched order therefore never reaches the authenticator.
 */
import {
  ApproveOrderResponse,
  OrderView,
  orderHash,
  PayInPlaceIntentResponse,
  type AuthenticationResponseJSON,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { signWithPasskey } from "@/lib/passkeys";

import { api } from "../client";
import { keys, moneyKeys } from "../keys";

export class OrderIntegrityError extends Error {
  constructor() {
    super("The order hash does not match the canonical order");
    this.name = "OrderIntegrityError";
  }
}

export function useOrder(proposalId: string) {
  return useQuery({
    queryKey: keys.order(proposalId),
    queryFn: ({ signal }) =>
      api.request(`/orders/${encodeURIComponent(proposalId)}`, { schema: OrderView, signal }),
    enabled: proposalId.length > 0,
    // The sheet must show the server's current order, never a stale cached one.
    staleTime: 0,
  });
}

/** True when the order, its hash and the passkey challenge all agree (I3). */
export function verifyOrderIntegrity(view: OrderView): boolean {
  let computed: string;
  try {
    computed = orderHash(view.canonicalOrder);
  } catch {
    return false;
  }
  if (computed !== view.orderHash) return false;
  if (view.webauthnOptions && view.webauthnOptions.challenge !== view.orderHash) return false;
  return true;
}

export function useApproveOrder(proposalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (view: OrderView) => {
      if (!view.webauthnOptions || !verifyOrderIntegrity(view)) throw new OrderIntegrityError();
      const assertion: AuthenticationResponseJSON = await signWithPasskey(view.webauthnOptions);
      return api.request(`/orders/${encodeURIComponent(proposalId)}/approve`, {
        json: { assertion },
        schema: ApproveOrderResponse,
      });
    },
    onSettled: () =>
      Promise.all(
        [keys.order(proposalId), ...moneyKeys].map((queryKey) => qc.invalidateQueries({ queryKey }))
      ),
  });
}

export function useRejectOrder(proposalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request(`/orders/${encodeURIComponent(proposalId)}/reject`, { json: {} }),
    onSettled: () =>
      Promise.all(
        [keys.order(proposalId), keys.proposalsPending, keys.ledger].map((queryKey) =>
          qc.invalidateQueries({ queryKey })
        )
      ),
  });
}

/** Pay in place: the PaymentIntent for an approved PAY_IN_PLACE payment. */
export function usePayInPlaceIntent() {
  return useMutation({
    mutationFn: (paymentId: string) =>
      api.request(`/payments/${encodeURIComponent(paymentId)}/intent`, {
        json: {},
        schema: PayInPlaceIntentResponse,
      }),
  });
}
