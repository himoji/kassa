import { useEffect } from "react";

import { storage } from "@/lib/storage";

import { createPersistedStore } from "./create-store";

/**
 * The last send from the Send screen (recipient, amount, purpose, where from), on this device only, so "Send again"
 * is one tap. Nothing here is trusted: the server proposes and checks the send like any other.
 */
export interface LastSend {
  payeeId: string;
  amountMinor: number;
  currency: string;
  purpose: string;
  /** null = the Kassa wallet. */
  fundingSourceId: string | null;
}

export interface LastSendState {
  last: LastSend | null;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export const lastSendStore = createPersistedStore<LastSendState>({
  key: "kassa:last-send",
  initial: { last: null },
  storage,
  parse: (raw) => {
    const p = (JSON.parse(raw) as { last?: Record<string, unknown> } | null)?.last;
    if (!p) return { last: null };
    const { payeeId, amountMinor, currency, purpose, fundingSourceId } = p;
    if (!isString(payeeId) || !isString(currency) || typeof purpose !== "string") return undefined;
    if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0)
      return undefined;
    return {
      last: {
        payeeId,
        amountMinor,
        currency,
        purpose,
        fundingSourceId: isString(fundingSourceId) ? fundingSourceId : null,
      },
    };
  },
});

export function rememberSend(last: LastSend): void {
  lastSendStore.setState({ last });
}

export function useLastSend(): LastSend | null {
  useEffect(() => {
    void lastSendStore.hydrate();
  }, []);
  return lastSendStore.useStore().last;
}
