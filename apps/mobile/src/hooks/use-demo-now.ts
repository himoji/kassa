/**
 * "Now" on the server's Clock (spec §15: real time + demo offset). Countdowns to cooling ends and
 * rule-change `effectiveAt` must use it, or advancing the demo clock would not move them.
 * The offset comes from GET /me (`demo.clockOffsetMs`; 0 when the demo is off).
 */
import { useEffect, useState } from "react";

import { useMe } from "@/api/hooks/me";

export function useDemoNow(tickMs = 1_000): number {
  const { data } = useMe();
  const offset = data?.demo?.clockOffsetMs ?? 0;
  const [real, setReal] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setReal(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return real + offset;
}
