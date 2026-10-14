/**
 * Demo personas the "Try the demo" button can claim. `dana` is the seeded hero (server
 * `demoClaim: true`); the others are seed `personas` keys sent as `demoClaim: "<key>"`.
 * This list is also the allow-list for the welcome route's `?persona=<key>` query.
 */
export const DEMO_PERSONAS = [
  "dana",
  "li-wei",
  "li-wei-cn",
  "pizzeria-bud",
  "pizzeria-sha",
] as const;

export type DemoPersona = (typeof DEMO_PERSONAS)[number];

export const DEFAULT_DEMO_PERSONA: DemoPersona = "dana";

/** Business-mode personas (a pizzeria's till, stock and supplier orders): outside the student/cross-border story. */
const BUSINESS_PERSONAS: readonly DemoPersona[] = ["pizzeria-bud", "pizzeria-sha"];

/**
 * The persona chips the welcome screen shows. Business personas are hidden unless EXPO_PUBLIC_SHOW_BUSINESS=true,
 * but one opened by `?persona=` is still shown, so a direct link keeps working.
 */
export function visibleDemoPersonas(selected: DemoPersona, showBusiness: boolean): DemoPersona[] {
  return DEMO_PERSONAS.filter(
    (p) => showBusiness || p === selected || !BUSINESS_PERSONAS.includes(p)
  );
}

/** Validates a `?persona=` query value; anything not on the allow-list falls back to Dana. */
export function parseDemoPersona(raw: string | string[] | undefined): DemoPersona {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (DEMO_PERSONAS as readonly string[]).includes(value ?? "")
    ? (value as DemoPersona)
    : DEFAULT_DEMO_PERSONA;
}

/** The register `demoClaim` value for a persona: `true` for Dana, the persona key otherwise. */
export function demoClaimFor(persona: DemoPersona): true | string {
  return persona === DEFAULT_DEMO_PERSONA ? true : persona;
}
