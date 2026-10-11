/** TanStack Query keys, one place so mutations invalidate exactly what they change. */
export const keys = {
  me: ["me"] as const,
  balances: ["balances"] as const,
  budgets: ["budgets"] as const,
  obligations: ["obligations"] as const,
  forecast: ["forecast"] as const,
  cards: ["cards"] as const,
  cardFees: ["cards", "fees"] as const,
  transactions: ["transactions"] as const,
  payees: ["payees"] as const,
  mandates: ["mandates"] as const,
  caps: ["caps"] as const,
  ruleChanges: ["rule-changes", "pending"] as const,
  proposalsPending: ["proposals", "pending"] as const,
  order: (proposalId: string) => ["orders", proposalId] as const,
  ledger: ["ledger"] as const,
  notifications: ["notifications"] as const,
  handoff: (paymentId: string) => ["handoff", paymentId] as const,
  verify: (id: string) => ["verify", id] as const,
};

/** Everything that depends on money state: refreshed after approvals, freezes and demo actions. */
export const moneyKeys = [
  keys.me,
  keys.balances,
  keys.budgets,
  keys.obligations,
  keys.forecast,
  keys.cardFees,
  keys.transactions,
  keys.payees,
  keys.mandates,
  keys.caps,
  keys.ruleChanges,
  keys.proposalsPending,
  keys.ledger,
  keys.notifications,
];
