import { PlanAdviceResponse, type PlanAdviceRequest } from "@kassa/shared";
import { useMutation } from "@tanstack/react-query";

import { api } from "../client";

/** POST /plan/advice: where the savings goal lands and which budgets to trim (advice only, nothing is applied). */
export function usePlanAdvice() {
  return useMutation({
    mutationFn: (body: PlanAdviceRequest) =>
      api.request("/plan/advice", { json: body, schema: PlanAdviceResponse }),
  });
}
