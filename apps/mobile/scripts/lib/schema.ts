/**
 * zod schema for `modules/<category>/<option>/module.json` (docs/module-spec.md).
 * Every field except `id` / `category` / `label` has a default, so `none` / `off`
 * modules can be tiny.
 */
import { z } from "zod";

import { CATEGORIES } from "./catalog.ts";

const record = z.record(z.string(), z.string());

export const providerSchema = z.object({
  import: z.string().min(1),
  as: z.string().min(1).optional(),
  from: z.string().min(1),
  order: z.number().int().min(0).max(99),
});
export type ProviderSpec = z.infer<typeof providerSchema>;

export const envSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "env keys are UPPER_SNAKE_CASE"),
  example: z.string().default(""),
  required: z.boolean().default(false),
  docsUrl: z.string().default(""),
  /**
   * Server-only secret (no `EXPO_PUBLIC_` prefix): read via `process.env.X` in
   * `src/app/api/**` / `src/server/**`, listed in `.env.example` under the server
   * section and checked by doctor, but never rendered into `src/lib/env.ts`.
   */
  server: z.boolean().default(false),
});
export type EnvSpec = z.infer<typeof envSchema>;

export const doctorCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("env"), keys: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("devBuild") }),
]);
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

/** `app.expo` patch: JSON merge patch; `plugins` append-unique by plugin id. */
export const appPatchSchema = z.object({
  expo: z.record(z.string(), z.unknown()).default({}),
});
export type AppPatch = z.infer<typeof appPatchSchema>;

/**
 * What the module's SDK collects, declared once and composed by the resolver into
 * `ios.privacyManifests` (Apple privacy manifest) and the Play Data safety draft
 * (`.readynative.json` → `modules.privacy.dataSafety`, read by `doctor --store`).
 */
export const privacySchema = z.object({
  /** `NSPrivacyCollectedDataTypes` entries. */
  dataTypes: z
    .array(
      z.object({
        type: z.string().regex(/^NSPrivacyCollectedDataType/),
        linked: z.boolean().default(false),
        tracking: z.boolean().default(false),
        purposes: z.array(z.string().regex(/^NSPrivacyCollectedDataTypePurpose/)).min(1),
      })
    )
    .default([]),
  /** `NSPrivacyAccessedAPITypes` entries (required-reason APIs). */
  accessedApis: z
    .array(
      z.object({
        type: z.string().regex(/^NSPrivacyAccessedAPICategory/),
        reasons: z.array(z.string().min(1)).min(1),
      })
    )
    .default([]),
  /** `NSPrivacyTracking`: the SDK tracks users across apps/companies (ATT territory). */
  tracking: z.boolean().default(false),
  trackingDomains: z.array(z.string().min(1)).default([]),
  /** One row of the Play Data safety draft; omit for modules that collect nothing. */
  playDataSafety: z
    .object({
      sdk: z.string().min(1),
      collects: z.array(z.string().min(1)).min(1),
      sharedWith: z.string().min(1),
      disclosureUrl: z.string().url(),
    })
    .optional(),
});
export type ModulePrivacy = z.infer<typeof privacySchema>;

export const moduleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "module ids are kebab-case"),
  category: z.enum(CATEGORIES as [string, ...string[]]),
  label: z.string().min(1),
  hint: z.string().default(""),
  /**
   * Setup walkthrough for this option: a docs path (`/docs/features/auth/supabase#setup`)
   * or an absolute URL. Defaults to the generated docs page (see `resolveGuide`), so only
   * a module whose guide lives elsewhere sets it.
   */
  guide: z.string().optional(),
  expoGo: z.boolean().default(true),
  /** Flagged as "most people pick this" in the docs; does not affect resolution. */
  recommended: z.boolean().default(false),
  dependencies: record.default({}),
  devDependencies: record.default({}),
  expoInstall: z.array(z.string()).default([]),
  package: z.record(z.string(), z.unknown()).default({}),
  app: appPatchSchema.default({ expo: {} }),
  tsconfig: z.object({ include: z.array(z.string()).default([]) }).default({ include: [] }),
  files: z.array(z.string().min(1)).default([]),
  removeFiles: z.array(z.string().min(1)).default([]),
  providers: z.array(providerSchema).default([]),
  env: z.array(envSchema).default([]),
  requires: z.record(z.string(), z.array(z.string())).default({}),
  recommends: z.record(z.string(), z.string()).default({}),
  conflicts: z.array(z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)).default([]),
  gen: z.array(z.string()).default([]),
  doctor: z.array(doctorCheckSchema).default([]),
  postSetup: z.array(z.string()).default([]),
  privacy: privacySchema.default({
    dataTypes: [],
    accessedApis: [],
    tracking: false,
    trackingDomains: [],
  }),
});

export type ModuleJson = z.infer<typeof moduleSchema>;
/** What a module.json author writes (defaults not yet applied). */
export type ModuleJsonInput = z.input<typeof moduleSchema>;

export type { Category, PresetName, Selection } from "./catalog.ts";
