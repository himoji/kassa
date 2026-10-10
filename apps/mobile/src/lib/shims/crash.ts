/** No-op crash reporting (contract 5). Replaced by the selected crash module. */

export type CrashContext = Record<string, unknown>;

export interface Crash {
  capture(err: unknown, ctx?: CrashContext): void;
}

/** `false` here; the crash module exports `true` so the crash-report toggle is shown. */
export const crashEnabled = false;

export const crash: Crash = {
  capture: (err, ctx) => {
    if (__DEV__) console.error("[crash]", err, ctx ?? "");
  },
};
