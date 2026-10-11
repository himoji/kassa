/*
 * Connects rules → payments at startup without a static import from rules to payments, so the agent's
 * import graph (agent → rules) never reaches payments (I1). server.ts and tests call wireExecutor().
 */
import { executeApproval } from "../payments/index.ts";
import { registerExecutor } from "../rules/index.ts";

export function wireExecutor(): void {
  registerExecutor(executeApproval);
}
