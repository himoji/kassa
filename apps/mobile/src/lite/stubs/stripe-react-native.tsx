/**
 * Metro alias for `@stripe/stripe-react-native` in the KassaLite build (metro.config.js): the module is
 * excluded from autolinking (no in-app payments in lite). Only the surface the shared order screen
 * imports exists; every call reports "unsupported".
 */
import type { ReactNode } from "react";

const unsupported = {
  error: { code: "Unsupported", message: "Payments are not available in KassaLite" },
};

export function StripeProvider({ children }: { publishableKey?: string; children?: ReactNode }) {
  return <>{children}</>;
}

export function useStripe() {
  return {
    initPaymentSheet: async () => unsupported,
    presentPaymentSheet: async () => unsupported,
  };
}
