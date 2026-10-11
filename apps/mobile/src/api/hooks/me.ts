import { MeResponse, FreezeResponse } from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSessionStore } from "@/stores/session";

import { api } from "../client";
import { keys, moneyKeys } from "../keys";

export function useMe() {
  const status = useSessionStore((s) => s.status);
  return useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.request("/me", { schema: MeResponse, signal }),
    enabled: status === "authenticated",
  });
}

/** POST /freeze - instant (I8: tightening applies immediately). */
export function useFreeze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.request("/freeze", { method: "POST", json: {}, schema: FreezeResponse }),
    onSettled: () => Promise.all(moneyKeys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}
