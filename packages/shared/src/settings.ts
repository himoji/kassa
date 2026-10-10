import { z } from "zod";

import { AgentAutonomy, MoneyMode, NotificationMode, PaymentPolicy, Preset, Region } from "./enums.ts";

/**
 * Presets (spec §10, build plan preset table). The advanced switches are derived from the preset
 * unless overridden; `null` override = follow the preset.
 */
export const PRESET_DEFAULTS = {
  ASK_ME: { agentAutonomy: "ON_REQUEST", paymentPolicy: "ALWAYS_ASK", moneyMode: "PAY_IN_PLACE" },
  SMART: { agentAutonomy: "PLAN_AHEAD", paymentPolicy: "RISK_BASED", moneyMode: "CAPPED_WALLET" },
  AUTOPILOT: { agentAutonomy: "PLAN_AND_ACT", paymentPolicy: "NEVER_ASK", moneyMode: "CAPPED_WALLET" },
} as const satisfies Record<
  Preset,
  { agentAutonomy: AgentAutonomy; paymentPolicy: PaymentPolicy; moneyMode: MoneyMode }
>;

export const SettingsOverrides = z.object({
  agentAutonomy: AgentAutonomy.nullable(),
  paymentPolicy: PaymentPolicy.nullable(),
  moneyMode: MoneyMode.nullable(),
});
export type SettingsOverrides = z.infer<typeof SettingsOverrides>;

export const EffectiveSettings = z.object({
  agentAutonomy: AgentAutonomy,
  paymentPolicy: PaymentPolicy,
  moneyMode: MoneyMode,
});
export type EffectiveSettings = z.infer<typeof EffectiveSettings>;

export function effectiveSettings(preset: Preset, overrides: SettingsOverrides): EffectiveSettings {
  const d = PRESET_DEFAULTS[preset];
  return {
    agentAutonomy: overrides.agentAutonomy ?? d.agentAutonomy,
    paymentPolicy: overrides.paymentPolicy ?? d.paymentPolicy,
    moneyMode: overrides.moneyMode ?? d.moneyMode,
  };
}

/**
 * Spec §10: invalid combinations are rejected. "Never ask" only makes sense when Kassa itself can
 * pay inside a mandate (capped wallet): HANDOFF and PAY_IN_PLACE both need the user at pay time.
 */
export function settingsViolations(eff: EffectiveSettings): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (eff.paymentPolicy === "NEVER_ASK" && (eff.moneyMode === "HANDOFF" || eff.moneyMode === "PAY_IN_PLACE")) {
    out.push({
      path: "overrides.paymentPolicy",
      message: `NEVER_ASK is invalid with money mode ${eff.moneyMode}`,
    });
  }
  return out;
}

/** Full user settings, validated with the preset refinement. The API merges a PATCH into this and re-parses. */
export const UserSettings = z
  .object({
    preset: Preset,
    region: Region,
    homeCurrency: z.string().regex(/^[A-Z]{3}$/),
    notificationMode: NotificationMode,
    overrides: SettingsOverrides,
  })
  .superRefine((s, ctx) => {
    for (const v of settingsViolations(effectiveSettings(s.preset, s.overrides))) {
      ctx.addIssue({ code: "custom", path: v.path.split("."), message: v.message });
    }
  });
export type UserSettings = z.infer<typeof UserSettings>;

/** `PATCH /settings` body. Partial; validity is checked after merging with the stored settings. */
export const SettingsPatch = z
  .object({
    preset: Preset,
    region: Region,
    homeCurrency: z.string().regex(/^[A-Z]{3}$/),
    notificationMode: NotificationMode,
    overrides: SettingsOverrides.partial(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** Merge a patch into stored settings and validate (throws a ZodError on an invalid combination). */
export function applySettingsPatch(current: UserSettings, patch: SettingsPatch): UserSettings {
  return UserSettings.parse({
    ...current,
    ...patch,
    overrides: { ...current.overrides, ...patch.overrides },
  });
}
