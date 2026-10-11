/**
 * Pay in place, native (spec §11): Stripe PaymentSheet (test mode) for the exact approved amount.
 * On success the server's `payment_intent.succeeded` webhook drives the rest (one-time card).
 */
import { StripeProvider, useStripe } from "@stripe/stripe-react-native";
import { useState } from "react";

import { usePayInPlaceIntent } from "@/api/hooks/orders";
import { errorText } from "@/components/kassa/error-text";
import { SimulatedBadge } from "@/components/kassa/badges";
import { Box, Button, Text } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { readynative } from "@/lib/readynative";

import type { PayInPlaceProps } from "./types";

function Sheet({ clientSecret, onDone }: { clientSecret: string; onDone: () => void }) {
  const t = useKassaT();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pay = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const init = await initPaymentSheet({
        paymentIntentClientSecret: clientSecret,
        merchantDisplayName: readynative.app.name,
      });
      if (init.error) throw new Error(init.error.message);
      const result = await presentPaymentSheet();
      if (result.error) {
        if (result.error.code === "Canceled") return;
        throw new Error(result.error.message);
      }
      haptics.success();
      onDone();
    } catch {
      haptics.error();
      setMessage(t("order:payInPlaceFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box gap={3}>
      <Button size="lg" onPress={() => void pay()} loading={busy}>
        {t("order:payInPlaceButton")}
      </Button>
      {message ? <Text color="destructive">{message}</Text> : null}
    </Box>
  );
}

export function PayInPlace({ paymentId, onDone }: PayInPlaceProps) {
  const t = useKassaT();
  const intent = usePayInPlaceIntent();
  const data = intent.data;

  if (!data) {
    return (
      <Box gap={3}>
        <SimulatedBadge />
        <Text variant="caption">{t("order:payInPlaceIntro")}</Text>
        <Button onPress={() => intent.mutate(paymentId)} loading={intent.isPending}>
          {t("order:payInPlacePrepare")}
        </Button>
        {intent.error ? <Text color="destructive">{errorText(t, intent.error)}</Text> : null}
      </Box>
    );
  }
  return (
    <StripeProvider publishableKey={data.publishableKey}>
      <Sheet clientSecret={data.clientSecret} onDone={onDone} />
    </StripeProvider>
  );
}
