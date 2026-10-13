/** KassaLite pairing, full-app side: POST /auth/pair/start (passkey-gated: 428 first, then the assertion). */
import { PairStartResponse } from "@kassa/shared";
import { useMutation } from "@tanstack/react-query";

import { api } from "../client";
import { withPasskeyGate } from "../passkey-gate";

export function startPairing() {
  return withPasskeyGate((proof) =>
    api.request("/auth/pair/start", {
      method: "POST",
      json: proof,
      schema: PairStartResponse,
    })
  );
}

export function usePairStart() {
  return useMutation({ mutationFn: startPairing });
}
