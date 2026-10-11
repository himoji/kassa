/**
 * Pay in place, web (spec §3, §11): Stripe Payment Element (test mode). `redirect: "if_required"`
 * keeps card payments in-page; 3-D Secure redirects come back to the same URL.
 */
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useMemo, useState } from "react";

import { usePayInPlaceIntent } from "@/api/hooks/orders";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { Box, Button, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

import type { PayInPlaceProps } from "./types";

function Form({ onDone }: { onDone: () => void }) {
  const t = useKassaT();
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pay = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setMessage(null);
    const result = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });
    setBusy(false);
    if (result.error) {
      setMessage(t("order:payInPlaceFailed"));
      return;
    }
    onDone();
  };

  return (
    <Box gap={3}>
      <PaymentElement />
      <Button size="lg" onPress={() => void pay()} loading={busy} disabled={!stripe}>
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
  const stripePromise = useMemo<Promise<Stripe | null> | null>(
    () => (data ? loadStripe(data.publishableKey) : null),
    [data]
  );

  if (!data || !stripePromise) {
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
    <Elements stripe={stripePromise} options={{ clientSecret: data.clientSecret }}>
      <Form onDone={onDone} />
    </Elements>
  );
}
