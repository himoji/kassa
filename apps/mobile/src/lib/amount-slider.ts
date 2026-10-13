/**
 * Slider quantisation for an amount in minor units: a power of ten about a tenth of the current
 * value, so the slider has 10-30 stops. Input granularity only - the server validates the amount.
 */
export function sliderStep(currentMinor: number): number {
  const base = Math.max(1, Math.abs(currentMinor) / 10);
  return 10 ** Math.floor(Math.log10(base));
}

/** Upper end of the range: three times the current value, and at least 30 steps. */
export function sliderMax(currentMinor: number, step: number): number {
  return Math.max(step * 30, Math.ceil((currentMinor * 3) / step) * step);
}

/** Bounds for a suggested amount: explicit bounds win, else 0 … sliderMax around the suggestion. */
export function amountRange(
  defaultMinor: number,
  cfg: { minMinor?: number; maxMinor?: number; stepMinor?: number } = {}
): { min: number; max: number; step: number } {
  const step = cfg.stepMinor ?? sliderStep(defaultMinor);
  const min = cfg.minMinor ?? 0;
  const max = Math.max(min + step, cfg.maxMinor ?? sliderMax(defaultMinor, step));
  return { min, max, step };
}

/** A slider value snapped to the step and clamped to the range (sliders report floats). */
export function snapAmount(value: number, r: { min: number; max: number; step: number }): number {
  const snapped = r.min + Math.round((value - r.min) / r.step) * r.step;
  return Math.min(r.max, Math.max(r.min, snapped));
}
