/** No-op payments (contract 5). Replaced by the selected payments module. */

export interface Entitlements {
  /** Active entitlement identifiers (e.g. "pro"). */
  active: string[];
  loading: boolean;
}

export interface Payments {
  useEntitlements(): Entitlements;
  /** Re-syncs purchases from the store; resolves even when nothing was restored. */
  restorePurchases(): Promise<void>;
  /** Opens the module's paywall; `undefined` when the module has none (shim, stripe web checkout). */
  presentPaywall?(): Promise<void>;
  /**
   * Detach the store SDK from the signed-in user (a new anonymous customer), so nothing the
   * app does next re-creates the customer that account deletion is about to erase. Optional:
   * modules without a per-user SDK (the shim, Stripe) leave it out.
   */
  logOut?(): Promise<void>;
}

const NO_ENTITLEMENTS: Entitlements = { active: [], loading: false };

export const payments: Payments = {
  useEntitlements: () => NO_ENTITLEMENTS,
  restorePurchases: () => Promise.resolve(),
};
