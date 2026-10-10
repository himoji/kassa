/**
 * bun doctor [--root <dir>] [--store]
 *
 * Checklist: .readynative.json, env keys of selected modules, placeholders in
 * readynative.config.ts, eas login, native toolchains when a dev build is needed,
 * package manager and bun/node versions. Exit 1 on any ✗ (a ! is advisory).
 * Store / release placeholders (bundle id, urls, store ids, EAS link, the placeholder icon)
 * are listed under "Before you ship" as ! - so a fresh clone exits 0 - and become ✗ with
 * `--store`.
 *
 * `--store` (Pro) appends the App Store / Google Play review check (lib/store-check.ts):
 * usage strings, export compliance, ATT, legal URLs, paywall, account deletion, Sign in
 * with Apple, plus a Data safety draft. Exit 1 on any blocking finding.
 */
import { parseArgs, resolveRoot } from "./lib/args.ts";
import { formatChecklist, runDoctor } from "./lib/doctor.ts";
import { DOCS_URL, readReadyNativeJson, stackUrl } from "./lib/readynative-state.ts";
import {
  dataSafetyDraft,
  formatDataSafetyDraft,
  formatStoreFindings,
  hasBlockingFindings,
  storeCheck,
  storeTierGate,
} from "./lib/store-check.ts";

const USAGE = `Usage: bun doctor [--root <dir>] [--store]

  --store   App Store / Google Play review check (ReadyNative Pro)
`;

/** Prints the store report; true when a blocking finding was printed. Pro-gated. */
async function runStore(root: string): Promise<boolean> {
  console.log("\nStore review check");
  const gate = storeTierGate(root);
  if (gate) {
    console.log(gate);
    return false;
  }
  const findings = await storeCheck(root);
  console.log(formatStoreFindings(findings));
  const state = readReadyNativeJson(root);
  const draft = formatDataSafetyDraft(dataSafetyDraft(state));
  if (draft) console.log(`\n${draft}`);
  const blocking = findings.filter((f) => f.severity === "block").length;
  console.log(
    blocking
      ? `\n${blocking} blocking store finding(s). Guide: ${DOCS_URL}/docs/pass-app-review`
      : `\nNo blocking store findings. Guide: ${DOCS_URL}/docs/pass-app-review`
  );
  return hasBlockingFindings(findings);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["help", "store"]);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const root = resolveRoot(flags);
  const results = await runDoctor({ root, strict: flags.store === true });
  console.log(formatChecklist(results));
  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn" && !r.ship).length;
  const ship = results.filter((r) => r.status === "warn" && r.ship).length;
  const warned =
    (warnings ? ` ${warnings} warning(s).` : "") +
    (ship ? ` ${ship} item(s) to do before you ship.` : "");
  console.log(failures ? `\n${failures} problem(s).${warned}` : `\nAll good.${warned}`);
  // Not a check row: the docs, pre-filtered to this tree's selection.
  const state = readReadyNativeJson(root);
  if (state) console.log(`\nDocs for your stack: ${stackUrl(state.selection)}`);

  const storeBlocked = flags.store === true ? await runStore(root) : false;
  if (failures || storeBlocked) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
