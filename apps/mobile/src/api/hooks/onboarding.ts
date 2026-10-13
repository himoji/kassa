import {
  type CapsPatch,
  type ChoiceAnswer,
  jcsHash,
  OnboardingConfirmOptionsResponse,
  OnboardingConfirmResponse,
  OnboardingMessageResponse,
} from "@kassa/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../client";
import { keys } from "../keys";
import { signPasskeyChallenge } from "../passkey-sign";

export function useOnboardingMessage() {
  return useMutation({
    mutationFn: (body: { conversationId: string; text: string; choice?: ChoiceAnswer }) =>
      api.request("/onboarding/message", { json: body, schema: OnboardingMessageResponse }),
  });
}

/** Changes made on the review sheet; the server rebuilds (and re-hashes) the rules with them. */
export interface OnboardingReviewEdits {
  caps?: CapsPatch;
  budgets?: { category: string; limitHomeMinor: number }[];
}

/**
 * The server-built base rules to review; the review screen renders only this. With `edits`, the
 * server builds the core from them, so what is signed is still exactly what the server returned.
 */
export function useOnboardingReview(conversationId: string, edits: OnboardingReviewEdits = {}) {
  return useQuery({
    queryKey: ["onboarding", "review", conversationId, edits],
    queryFn: ({ signal }) =>
      api.request("/onboarding/confirm/options", {
        json: { conversationId, ...edits },
        schema: OnboardingConfirmOptionsResponse,
        signal,
      }),
    staleTime: 0,
    placeholderData: keepPreviousData,
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
