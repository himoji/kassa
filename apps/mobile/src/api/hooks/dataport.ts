/**
 * Data import / export (GET /export, POST /import/preview, POST /import/commit). Imported budgets are applied
 * separately with PUT /budgets (useSetBudgets), because raising a budget needs the passkey.
 */
import {
  ImportCommitResponse,
  ImportPreviewResponse,
  KassaExport,
  type ImportItems,
} from "@kassa/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Platform } from "react-native";

import { shareDataExport } from "@/lib/privacy";

import { api } from "../client";
import { keys, moneyKeys } from "../keys";

/** Web: a file download. Native: the share sheet (save to Files, AirDrop, mail…). */
async function saveJson(json: string, fileName: string): Promise<void> {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  await shareDataExport(json, { title: fileName });
}

export function useExportData() {
  return useMutation({
    mutationFn: async () => {
      const data = await api.request("/export", { schema: KassaExport });
      await saveJson(
        JSON.stringify(data, null, 2),
        `kassa-export-${data.exportedAt.slice(0, 10)}.json`
      );
      return data;
    },
  });
}

export function useImportPreview() {
  return useMutation({
    mutationFn: (text: string) =>
      api.request("/import/preview", { json: { text }, schema: ImportPreviewResponse }),
  });
}

export function useImportCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: ImportItems) =>
      api.request("/import/commit", { json: { items }, schema: ImportCommitResponse }),
    onSettled: () =>
      Promise.all([...moneyKeys, keys.cards].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

/** Web only: let the user pick a .json file and read it as text (native pastes or reads the clipboard). */
export function pickJsonFileOnWeb(): Promise<string | null> {
  if (Platform.OS !== "web" || typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void file.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}
