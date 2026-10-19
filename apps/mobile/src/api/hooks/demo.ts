/**
 * Demo panel (spec §15). Every call carries the demo admin token header; the server only
 * enables these routes with DEMO_ENABLED=true.
 */
import {
  DEMO_TOKEN_HEADER,
  DemoCoolingResponse,
  DemoStateResponse,
  type AgentMode,
  type ClockMode,
  type DemoScenario,
} from "@kassa/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { env } from "@/lib/env";

import { api } from "../client";
import { keys, moneyKeys } from "../keys";
import { withPasskeyGate } from "../passkey-gate";

function demoHeaders(): Record<string, string> {
  return env.DEMO_ADMIN_TOKEN ? { [DEMO_TOKEN_HEADER]: env.DEMO_ADMIN_TOKEN } : {};
}

export type DemoAction =
  | { kind: "advance"; hours: number }
  | { kind: "agent-mode"; mode: AgentMode }
  | { kind: "clock-mode"; mode: ClockMode }
  | { kind: "reset" }
  | { kind: "trigger"; scenario: DemoScenario };

function send(action: DemoAction) {
  const headers = demoHeaders();
  switch (action.kind) {
    case "advance":
      return api.request("/demo/clock/advance", {
        json: { hours: action.hours },
        headers,
        schema: DemoStateResponse,
      });
    case "agent-mode":
      return api.request("/demo/agent-mode", {
        json: { mode: action.mode },
        headers,
        schema: DemoStateResponse,
      });
    case "clock-mode":
      return api.request("/demo/clock/mode", {
        json: { mode: action.mode },
        headers,
        schema: DemoStateResponse,
      });
    case "reset":
      return api.request("/demo/reset", { json: {}, headers, schema: DemoStateResponse });
    case "trigger":
      return api.request(`/demo/trigger/${action.scenario}`, {
        json: {},
        headers,
        schema: DemoStateResponse,
      });
  }
}

export function useDemoAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: send,
    // The clock moves every countdown and due date: refresh everything, not only the money screens.
    onSettled: (_data, _err, action) =>
      action.kind === "advance" || action.kind === "clock-mode" || action.kind === "reset"
        ? qc.invalidateQueries()
        : Promise.all(moneyKeys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

/**
 * POST /demo/cooling: this user's 24 h waits (recipient cooling, loosening delays). Off needs the passkey (428 round
 * trip); on needs nothing. Not a demo admin call: it is the signed-in user's own switch.
 */
export function useDemoCooling() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      withPasskeyGate((proof) =>
        api.request("/demo/cooling", { json: { enabled, ...proof }, schema: DemoCoolingResponse })
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

const MoneyFromHomeResponse = z.object({
  currency: z.string(),
  amountMinor: z.number().int(),
  balanceAfterMinor: z.number().int(),
  simulated: z.literal(true),
});

/**
 * POST /demo/money-from-home: parents send money to this user's own wallet (simulated). The judge build and dev
 * sign-in sessions only; the server picks the wallet from the session. Not a demo admin call.
 */
export function useMoneyFromHome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.request("/demo/money-from-home", { json: {}, schema: MoneyFromHomeResponse }),
    onSettled: () => Promise.all(moneyKeys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
