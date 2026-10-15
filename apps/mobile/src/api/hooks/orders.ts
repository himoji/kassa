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

import { isLiteBuild } from "@/lite/variant";

import { api } from "../client";
import { KassaApiError } from "../errors";
import { keys, moneyKeys } from "../keys";
import { signPasskeyChallenge } from "../passkey-sign";

export class OrderIntegrityError extends Error {
  constructor() {
    super("The order hash does not match the canonical order");
    this.name = "OrderIntegrityError";
  }
}

/**
 * The order expired before the approval reached the server (410 ORDER_EXPIRED, X8). The server re-issued it
 * (`reissued`) and discarded the signature: nothing is paid until the user reviews the new order and approves
 * again. Never re-signed automatically.
 */
export class OrderReissuedError extends Error {
  constructor(readonly reissued: OrderView | null) {
    super("The order expired and was prepared again; review it before approving");
    this.name = "OrderReissuedError";
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
      if (!verifyOrderIntegrity(view)) throw new OrderIntegrityError();
      // KassaLite has no passkey: ask anyway, so the server's 428 opens this order in the web app (lite/approve.ts).
      if (isLiteBuild()) {
        return api.request(`/orders/${encodeURIComponent(proposalId)}/approve`, {
          json: {},
          schema: ApproveOrderResponse,
        });
      }
      if (!view.webauthnOptions) throw new OrderIntegrityError();
      const assertion: AuthenticationResponseJSON = await signPasskeyChallenge(
        view.webauthnOptions
      );
      try {
        return await api.request(`/orders/${encodeURIComponent(proposalId)}/approve`, {
          json: { assertion },
          schema: ApproveOrderResponse,
        });
      } catch (err) {
        if (err instanceof KassaApiError && err.status === 410 && err.code === "ORDER_EXPIRED") {
          const parsed = OrderView.safeParse(err.details);
          // Show the re-issued order in the sheet; the user approves it again explicitly.
          if (parsed.success) qc.setQueryData(keys.order(proposalId), parsed.data);
          throw new OrderReissuedError(parsed.success ? parsed.data : null);
        }
        throw err;
      }
    },
    onSettled: (_data, err) =>
      Promise.all(
        // After a re-issue the sheet keeps the new order from the 410 (a refetch would show the same one).
        [...(err instanceof OrderReissuedError ? [] : [keys.order(proposalId)]), ...moneyKeys].map(
          (queryKey) => qc.invalidateQueries({ queryKey })
        )
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
