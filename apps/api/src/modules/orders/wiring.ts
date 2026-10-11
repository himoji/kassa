/*
 * Connects rules → payments (and rules → the mock bank's read-only wallet balances) at startup without a
 * static import from rules to payments or rails, so the agent's import graph (agent → rules) never reaches
 * payments/** or rails/** (I1, checked transitively by test/invariants). server.ts and tests call wireExecutor().
 */
import { executeApproval } from "../payments/index.ts";
import { getWalletBalances } from "../rails/mockBank.ts";
import { registerExecutor } from "../rules/index.ts";
import { registerWalletReader } from "../rules/facts.ts";

export function wireExecutor(): void {
  registerExecutor(executeApproval);
  registerWalletReader(getWalletBalances);
}
