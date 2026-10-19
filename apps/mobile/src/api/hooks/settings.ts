import {
  CapsResponse,
  EraseResponse,
  RuleChangesResponse,
  SettingsPatchResponse,
  type CapsPatch,
  type SettingsPatch,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys } from "../keys";
import { withPasskeyGate } from "../passkey-gate";

export function useCaps() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.caps,
    queryFn: ({ signal }) => api.request("/caps", { schema: CapsResponse, signal }),
    enabled: authed,
  });
}

export function usePendingRuleChanges() {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  return useQuery({
    queryKey: keys.ruleChanges,
    queryFn: ({ signal }) =>
      api.request("/rule-changes?status=pending", { schema: RuleChangesResponse, signal }),
    enabled: authed,
    refetchInterval: 30_000,
  });
}

export type SettingsUpdate = SettingsPatch & { caps?: CapsPatch };

/**
 * PATCH /settings. Tightening applies at once; loosening comes back 428 PASSKEY_REQUIRED and is
 * signed with a passkey. Raised caps then apply at once; other loosenings land as a pending rule
 * change effective in 24 h (I8).
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: SettingsUpdate) =>
      withPasskeyGate((proof) =>
        api.request("/settings", {
          method: "PATCH",
          json: { ...update, ...proof },
          schema: SettingsPatchResponse,
        })
      ),
    onSettled: () =>
      Promise.all(
        [keys.me, keys.caps, keys.ruleChanges].map((queryKey) => qc.invalidateQueries({ queryKey }))
      ),
  });
}

/**
 * Delete the account (GDPR Art. 17): POST /privacy/erase, signed with the passkey. The server erases the user's data
 * and passkeys and keeps only what the law requires (EraseResponse.retained); the caller signs out afterwards.
 */
export function useEraseAccount() {
  return useMutation({
    mutationFn: () =>
      withPasskeyGate((proof) =>
        api.request("/privacy/erase", {
          json: { confirm: "ERASE", ...proof },
          schema: EraseResponse,
        })
      ),
  });
}
