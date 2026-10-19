/**
 * Whether a streaming reply is waiting on the model with nothing moving on screen: between tool rounds, or after
 * its last tool finished while the next step thinks. The chat then shows "Kassa is thinking", so a long turn never
 * looks frozen. Not while answer text streams, a tool shows "Working on it", or a card shows its pending row.
 */
export function waitingOnModel(
  message: { role: string; parts: readonly { type: string; state?: string }[] } | undefined
): boolean {
  if (!message || message.role !== "assistant") return true;
  const last = [...message.parts].reverse().find((p) => p.type !== "step-start");
  if (!last) return true;
  if (last.type === "text") return last.state === "done";
  if (last.type.startsWith("tool-") || last.type === "dynamic-tool")
    return last.state === "output-available" || last.state === "output-error";
  return false;
}
