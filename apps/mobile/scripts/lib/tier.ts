/**
 * Which tier a buyer tree was assembled as.
 *
 * `assemble` writes `.readynative-tier.json` at the root of the tree it produces; nothing
 * in the CLI may branch on the tier to decide what exists - the `modules/` tree is the
 * only truth. The tier is read purely to explain a missing module in the buyer's terms
 * ("that is part of Pro" - a missing module in `setup`, `doctor --store` in a Starter tree)
 * instead of "not in this tree".
 *
 * Survives `finalize` (doctor reads it after setup), so like lib/readynative-state.ts it must
 * not import the module system: the category / preset names below are plain strings, and
 * assemble.test.ts checks them against the catalog.
 */
import fs from "node:fs";
import path from "node:path";

export const TIER_IDS = ["free", "starter", "pro"] as const;
export type TierId = (typeof TIER_IDS)[number];

/** Categories whose options integrate a paid third-party service - the Pro line. */
export const SERVICE_CATEGORIES = [
  "auth",
  "payments",
  "analytics",
  "crash",
  "push",
  "backend",
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface TierSpec {
  label: string;
  /**
   * `owner/name` of the GitHub repo the tier ships to (`bun run publish`). Free is public,
   * the paid tiers are private; publish refuses a `--remote` that names any other repo.
   */
  repo: string;
  /** Categories assembled with their `none` option only (a subset of the catalog's). */
  excludeCategories: ServiceCategory[];
  /** Catalog `PresetName`s the tier cannot offer. */
  excludePresets: string[];
  examples: boolean;
  /**
   * Repo-relative globs (`dir/**` only) of files that ship with this tier and no other:
   * assemble copies them as-is. The Pro-only agent skill lives here; the scripts that
   * gate on the tier at runtime (`doctor --store`) ship in both tiers and are not listed.
   */
  extras: string[];
  /**
   * Category → the one option the tier ships (the Free tier: no choice at all). Wins over
   * `excludeCategories`; every category missing here keeps the tier's usual options.
   */
  pinned?: Record<string, string>;
  /**
   * The tree ships already set up: assemble runs `setup` with the pinned selection and
   * finalizes it, so the buyer gets a plain Expo app - no `modules/`, no `scripts/setup.ts`,
   * nothing of the module system. Requires every category in `pinned`.
   */
  finalized?: boolean;
  /** `commercial`: the repo's LICENSE; `mit`: the rendered MIT text (public tiers). */
  license: "commercial" | "mit";
  /**
   * Removed from a finalized tree after setup: the product tooling and the paid-tier extras
   * a public repo does not ship (`paths` are root-relative files or directories; the rest
   * edits package.json). assemble.test.ts checks every stripped dependency is unreferenced.
   */
  strip?: {
    paths: string[];
    dependencies: string[];
    scripts: string[];
    /** Top-level package.json keys. */
    packageKeys: string[];
    /** Always-on extras cut out of the source (`lib/cut-features.ts`). */
    features: string[];
  };
}

/** Contents of `.readynative-tier.json`. */
export interface TierFile {
  tier: TierId;
  label: string;
  version: string;
  sdk: number;
}

/**
 * The Free tier's stack, one option per category. Public on GitHub (MIT), so it is the
 * finished app rather than the picker: NativeWind 4, TanStack Query, Zustand on the
 * default storage adapter, everything else off.
 */
export const FREE_SELECTION: Readonly<Record<string, string>> = {
  ui: "nativewind4",
  data: "react-query",
  state: "zustand",
  storage: "kv-store",
  forms: "none",
  i18n: "none",
  auth: "none",
  payments: "none",
  analytics: "none",
  crash: "none",
  push: "none",
  backend: "none",
  onboarding: "off",
  location: "none",
  widgets: "none",
  consent: "none",
  testing: "none",
};

export const TIERS: Record<TierId, TierSpec> = {
  free: {
    label: "Free",
    repo: "ReadyNative/ready-native-free",
    excludeCategories: [...SERVICE_CATEGORIES],
    excludePresets: ["minimal", "default", "saas"],
    examples: false,
    extras: [],
    pinned: { ...FREE_SELECTION },
    finalized: true,
    license: "mit",
    // The app and its libraries, nothing else: no EAS, no CI, no agent files, no graph, no
    // scripts (doctor, gen:*), no Maestro flows, no deep-link files, no changelog, no OTA
    // banner, no review prompt, no Settings → Developer tools.
    strip: {
      paths: [
        ".github",
        "eas.json",
        "AGENTS.md",
        "docs",
        ".agents",
        "scripts",
        ".maestro",
        "public/.well-known",
        "CHANGELOG.md",
        ".readynative-tier.json",
      ],
      // Nothing left in the tree imports these (the test proves it); expo-dev-client stays
      // because app.config.ts lists its config plugin.
      // `@expo/ui` stays: the kit's `Sheet` is its BottomSheet.
      dependencies: [
        "expo-device",
        "expo-glass-effect",
        "expo-store-review",
        "expo-updates",
        "react-dom",
        "react-native-web",
        "sharp",
      ],
      scripts: [
        "web",
        "setup",
        "doctor",
        "gen",
        "gen:theme",
        "gen:links",
        "gen:privacy",
        "gen:assets",
        "gen:graph",
        "test:e2e",
        // The comment about scripts/* (a `//` key inside `scripts`).
        "//",
      ],
      packageKeys: [],
      features: ["updates-banner", "review-prompt", "tracking", "developer-tools"],
    },
  },
  starter: {
    label: "Starter",
    repo: "ReadyNative/ready-native-starter",
    excludeCategories: [...SERVICE_CATEGORIES],
    excludePresets: ["saas"],
    examples: false,
    extras: [],
    license: "commercial",
  },
  pro: {
    label: "Pro",
    repo: "ReadyNative/ready-native-pro",
    excludeCategories: [],
    excludePresets: [],
    examples: true,
    extras: [".agents/skills/store-review/**"],
    license: "commercial",
  },
};

/** Written at the assembled tree root: `{ tier, label, version, sdk }`. */
export const TIER_FILE = ".readynative-tier.json";

export function isTierId(value: unknown): value is TierId {
  return typeof value === "string" && (TIER_IDS as readonly string[]).includes(value);
}

/** `.readynative-tier.json` of an assembled tree; null when absent or unreadable. */
export function readTier(root: string): TierFile | null {
  const file = path.join(root, TIER_FILE);
  if (!fs.existsSync(file)) return null;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const raw = json as Partial<TierFile>;
  if (!isTierId(raw.tier)) return null;
  return {
    tier: raw.tier,
    label: typeof raw.label === "string" ? raw.label : TIERS[raw.tier].label,
    version: typeof raw.version === "string" ? raw.version : "",
    sdk: typeof raw.sdk === "number" ? raw.sdk : 0,
  };
}
