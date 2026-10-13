import {
  type ChoiceAnswer,
  jcsHash,
  OnboardingConfirmOptionsResponse,
  OnboardingConfirmResponse,
  OnboardingMessageResponse,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../client";
import { keys } from "../keys";
import { signPasskeyChallenge } from "../passkey-sign";

export function useOnboardingMessage() {
  return useMutation({
    mutationFn: (body: { conversationId: string; text: string; choice?: ChoiceAnswer }) =>
      api.request("/onboarding/message", { json: body, schema: OnboardingMessageResponse }),
  });
}

/** The server-built base rules to review; the review screen renders only this. */
export function useOnboardingReview(conversationId: string) {
  return useQuery({
    queryKey: ["onboarding", "review", conversationId],
    queryFn: ({ signal }) =>
      api.request("/onboarding/confirm/options", {
        json: { conversationId },
        schema: OnboardingConfirmOptionsResponse,
        signal,
      }),
    staleTime: 0,
  });
}

/**
 * Sign the base rules. Like orders, the app recomputes the hash of exactly what it shows and only
 * signs if it equals both the server's rulesHash and the WebAuthn challenge.
 */
export function useConfirmOnboarding(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (review: OnboardingConfirmOptionsResponse) => {
      const local = jcsHash(review.core);
      if (local !== review.rulesHash || review.webauthnOptions.challenge !== review.rulesHash) {
        throw new Error("Base rules hash mismatch");
      }
      const assertion = await signPasskeyChallenge(review.webauthnOptions);
      return api.request("/onboarding/confirm", {
        json: { conversationId, challengeId: review.challengeId, core: review.core, assertion },
        schema: OnboardingConfirmResponse,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}
