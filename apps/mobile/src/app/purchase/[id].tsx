import { TransactionDetailScreen } from "@/screens/transaction/transaction-detail-screen";

/** Opened from Activity → Spending, a spending notification, and by `kassa://purchase/<id>`. */
export default function Route() {
  return <TransactionDetailScreen />;
}
