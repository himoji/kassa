/**
 * Data import / export (GET /export, POST /import/preview, POST /import/file, POST /import/commit). Imported budgets
 * are applied separately with PUT /budgets (useSetBudgets), because raising a budget needs the passkey.
 */
import {
  ImportCommitResponse,
  ImportPreviewResponse,
  KassaExport,
  MoneyHistoryResponse,
  OnboardingMessageResponse,
  type ImportHistory,
  type ImportItems,
  type OnboardingHistoryRequest,
} from "@kassa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import { COMMIT_RETRY_WAITS_MS, COMMIT_TIMEOUT_MS, commitChunks } from "@/lib/commit-chunks";

import { KassaApiError } from "../errors";

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

/** POST /import/commit in chunks (cards, bills and incomes ride with the first), with progress. */
export function useImportCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      items,
      history,
      onProgress,
    }: {
      items: ImportItems;
      /** The preview's history: kept with the profile so the agent knows what the statements showed. */
      history?: ImportHistory | null;
      onProgress?: (done: number, total: number) => void;
    }) => {
      const chunks = commitChunks(items.transactions);
      if (chunks.length === 0) chunks.push([]);
      const total = items.transactions.length;
      let done = 0;
      const sum = ImportCommitResponse.parse({
        transactions: { imported: 0, duplicates: 0, failed: 0 },
        bills: { added: 0, skipped: 0 },
        cards: { added: 0, skipped: 0 },
      });
      for (const [i, transactions] of chunks.entries()) {
        const part =
          i === 0
            ? { ...items, transactions }
            : { transactions, bills: [], cards: [], budgets: [], incomes: [] };
        const send = () =>
          api.request("/import/commit", {
            method: "POST",
            json: { items: part, ...(i === chunks.length - 1 && history ? { history } : {}) },
            schema: ImportCommitResponse,
            timeoutMs: COMMIT_TIMEOUT_MS,
          });
        let r: ImportCommitResponse | undefined;
        for (let attempt = 0; !r; attempt++) {
          try {
            r = await send();
          } catch (err) {
            const wait = COMMIT_RETRY_WAITS_MS[attempt];
            if (!(err instanceof KassaApiError && err.status === 429) || wait === undefined)
              throw err;
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
        }
        for (const k of ["imported", "duplicates", "failed"] as const)
          sum.transactions[k] += r.transactions[k];
        for (const g of ["bills", "cards", "incomes"] as const) {
          sum[g].added += r[g].added;
          sum[g].skipped += r[g].skipped;
        }
        done += transactions.length;
        onProgress?.(done, total);
      }
      return sum;
    },
    onSettled: () =>
      Promise.all([...moneyKeys, keys.cards].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

/** A file the user picked: a web File, or a native file URI (the picker copies it to the app's cache). */
export type PickedFile =
  | { kind: "web"; file: File; name: string }
  | { kind: "native"; uri: string; name: string; mimeType: string };

/** Statement formats the server reads (it decides by the bytes; this only narrows the picker). */
const IMPORT_ACCEPT =
  ".pdf,.csv,.tsv,.txt,.xlsx,.json,.ofx,.qfx,application/pdf,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NATIVE_TYPES = [
  "application/pdf",
  "text/*",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream",
];

/**
 * Whether this build can open the system file picker. The picker is a native module: a KassaLite or app binary built
 * before it was added gets new JavaScript over the air but not the module, and must not crash on it.
 */
export function canPickFiles(): boolean {
  if (Platform.OS === "web") return typeof document !== "undefined";
  return requireOptionalNativeModule("ExpoDocumentPicker") !== null;
}

/** Let the user pick one or more statements (PDF, CSV, Excel, JSON, OFX). Null when cancelled or unavailable. */
export async function pickImportFiles(): Promise<PickedFile[] | null> {
  if (Platform.OS === "web") {
    if (typeof document === "undefined") return null;
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = IMPORT_ACCEPT;
      input.onchange = () => {
        const files = [...(input.files ?? [])].slice(0, 6);
        resolve(
          files.length
            ? files.map((file) => ({ kind: "web" as const, file, name: file.name }))
            : null
        );
      };
      input.click();
    });
  }
  if (!canPickFiles()) return null;
  // Loaded only after the check above: requiring the module evaluates requireNativeModule.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DocumentPicker = require("expo-document-picker") as typeof import("expo-document-picker");
  const res = await DocumentPicker.getDocumentAsync({
    type: NATIVE_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets?.length) return null;
  return res.assets.slice(0, 6).map((a) => ({
    kind: "native" as const,
    uri: a.uri,
    name: a.name,
    mimeType: a.mimeType ?? "application/octet-stream",
  }));
}

/** POST /import/file: the statements as multipart/form-data; the preview comes back, nothing is written yet. */
export function useImportFiles() {
  return useMutation({
    mutationFn: async ({
      files,
      ai = "auto",
    }: {
      files: PickedFile[];
      ai?: "auto" | "off" | "always";
    }) => {
      const form = new FormData();
      form.append("ai", ai);
      for (const f of files) {
        if (f.kind === "web") form.append("file", f.file, f.name);
        // React Native's FormData takes a file descriptor object for a local URI.
        else form.append("file", { uri: f.uri, name: f.name, type: f.mimeType } as unknown as Blob);
      }
      const res = await api.authorizedFetch(api.url("/import/file"), {
        method: "POST",
        body: form,
        headers: { accept: "application/json" },
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // not JSON: keep the text for the error
      }
      if (!res.ok) throw new KassaApiError(res.status, body);
      return ImportPreviewResponse.parse(body);
    },
  });
}

/** POST /onboarding/history: hand what the statements taught Kassa to the onboarding draft. */
export function useOnboardingHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: OnboardingHistoryRequest) =>
      api.request("/onboarding/history", {
        method: "POST",
        json: req,
        schema: OnboardingMessageResponse,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.moneyHistory }),
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

/** GET /history: the last imported bank history (the Home card), null before any import. */
export function useMoneyHistory() {
  return useQuery({
    queryKey: keys.moneyHistory,
    queryFn: ({ signal }) => api.request("/history", { schema: MoneyHistoryResponse, signal }),
  });
}
