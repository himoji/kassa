import { LinkedAccountsScreen } from "@/screens/wallet/linked-accounts-screen";

/** View only: linking a card needs the passkey (and Stripe), so it happens in the web app. */
export default function Route() {
  return <LinkedAccountsScreen viewOnly />;
}
