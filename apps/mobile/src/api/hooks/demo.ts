/**
 * Demo panel (spec §15). Every call carries the demo admin token header; the server only
 * enables these routes with DEMO_ENABLED=true.
 */
import {
  DEMO_TOKEN_HEADER,
  DemoStateResponse,
  type AgentMode,
  type ClockMode,
  type DemoScenario,
} from "@kassa/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { env } from "@/lib/env";

import { api } from "../client";
import { moneyKeys } from "../keys";

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
