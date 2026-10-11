/*
 * Connects rules → payments (and rules → the mock bank's read-only wallet balances) at startup without a
 * static import from rules to payments or rails, so the agent's import graph (agent → rules) never reaches
 * payments/** or rails/** (I1, checked transitively by test/invariants). server.ts and tests call wireExecutor().
 */
import { toHome } from "../money/fx.ts";
import { executeApproval, registerHomeConverter } from "../payments/index.ts";
import { requestHandoffQr } from "../rails/handoff.ts";
import { getWalletBalances } from "../rails/mockBank.ts";
import { registerExecutor, registerHandoffPreflight } from "../rules/index.ts";
import { registerWalletReader } from "../rules/facts.ts";

export function wireExecutor(): void {
  registerExecutor(executeApproval);
  // X7: HANDOFF orders fetch and check the merchant's QR when shown, before the passkey prompt.
  registerHandoffPreflight(requestHandoffQr);
  registerWalletReader(getWalletBalances);
  // X2: payments converts amounts for its own daily cap through this port (it imports no fx/rules code itself).
  registerHomeConverter(async (amountMinor, currency, homeCurrency, at) => (await toHome(amountMinor, currency, homeCurrency, at)).amountMinor);
}
