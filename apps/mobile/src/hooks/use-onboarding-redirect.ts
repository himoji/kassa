/**
 * onboarding/off: no redirect. Same hook name as `onboarding/on` so the root
 * layout never changes between the two options.
 */
/** `false` here, `true` in `onboarding/on`: Settings hides "Reset onboarding". */
export const onboardingEnabled = false;

export function useOnboardingRedirect(): void {}
