/**
 * Kassa Business mode (Business M4): read-only stock, forecast, sales and purchase orders of the owner's
 * merchant (GET /business/*). Enabled only for a BUSINESS account; a PERSONAL account would get 403.
 */
import {
  BusinessForecastResponse,
  BusinessInventoryResponse,
  BusinessPurchaseOrdersResponse,
  BusinessSalesTodayResponse,
  PurchaseOrderSignOptionsResponse,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";
import { signPasskeyChallenge } from "../passkey-sign";
import { useMe } from "./me";

/** True once /me says this is a BUSINESS account (false while loading, on error, or PERSONAL). */
export function useIsBusiness(): boolean {
  return useMe().data?.accountType === "BUSINESS";
}

function useBusinessEnabled(): boolean {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  const business = useIsBusiness();
  return authed && business;
}

export function useBusinessForecast() {
  const enabled = useBusinessEnabled();
  return useQuery({
    queryKey: keys.businessForecast,
    queryFn: ({ signal }) =>
      api.request("/business/forecast", { schema: BusinessForecastResponse, signal }),
    enabled,
  });
}

export function useBusinessInventory() {
  const enabled = useBusinessEnabled();
  return useQuery({
    queryKey: keys.businessInventory,
    queryFn: ({ signal }) =>
      api.request("/business/inventory", { schema: BusinessInventoryResponse, signal }),
    enabled,
  });
}

export function useSalesToday() {
  const enabled = useBusinessEnabled();
  return useQuery({
    queryKey: keys.businessSalesToday,
    queryFn: ({ signal }) =>
      api.request("/business/sales/today", { schema: BusinessSalesTodayResponse, signal }),
    enabled,
  });
}

export function usePurchaseOrders() {
  const enabled = useBusinessEnabled();
  return useQuery({
    queryKey: keys.businessPurchaseOrders,
    queryFn: ({ signal }) =>
      api.request("/business/purchase-orders", { schema: BusinessPurchaseOrdersResponse, signal }),
    enabled,
  });
}

const SignResult = z.object({
  id: z.string(),
  status: z.enum(["SIGNED", "SENT"]),
  poHash: z.string().nullable(),
});

/**
 * (Business M5) Sign a purchase order with the payments passkey: the server builds the exact core and returns
 * WebAuthn options whose challenge is poHash(core) (same flow as mandates); the signed PO is sent to the supplier.
 */
export function useSignPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const path = `/business/purchase-orders/${encodeURIComponent(id)}`;
      const options = await api.request(`${path}/sign/options`, {
        json: {},
        schema: PurchaseOrderSignOptionsResponse,
      });
      if (options.webauthnOptions.challenge !== options.poHash) {
        throw new Error("Purchase order challenge does not match the purchase order hash");
      }
      const assertion = await signPasskeyChallenge(options.webauthnOptions);
      return api.request(`${path}/sign`, {
        json: { core: options.core, assertion },
        schema: SignResult,
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.businessPurchaseOrders }),
  });
}
