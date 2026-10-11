/*
 * Risk score weights (spec §10 table). R = Σ w_i f_i with each feature f_i in [0,1]; weights sum to 1.
 * Documented in the tech doc; change only together with the tests in test/rules/risk.test.ts.
 */
export const RISK_WEIGHTS = {
  newMerchant: 0.3,
  priceAboveMedian: 0.15,
  budgetShare: 0.2,
  quantityVsHistory: 0.1,
  unusualHour: 0.05,
  triggerOrigin: 0.1,
  readerUnverifiedNonCritical: 0.1,
} as const;

export type RiskFeature = keyof typeof RISK_WEIGHTS;
export type RiskFeatures = Record<RiskFeature, number>;

/** SMART asks at R ≥ 0.5 (spec §10 step 8). */
export const SMART_RISK_THRESHOLD = 0.5;
