import { TransactionDetailScreen } from "@/screens/transaction/transaction-detail-screen";

/** Opened from Activity, from a purchase notification, and by `kassalite://purchase/<id>`. */
export default function Route() {
  return <TransactionDetailScreen />;
}
