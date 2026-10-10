/**
 * auth/none: no redirect. Same hook name as every auth module so the root
 * layout never changes between options.
 *
 * Contract an auth module's `useAuthRedirect()` must implement:
 * - read `auth.useSession()` (`@/lib/auth`) and `useSegments()`;
 * - gate on `Boolean(useRootNavigationState()?.key)` like `useOnboardingRedirect`;
 * - do nothing while `status === "loading"`;
 * - `status === "unauthenticated"` and `segments[0] !== "(auth)"` →
 *   `router.replace("/(auth)/sign-in")`;
 * - `status === "authenticated"` and `segments[0] === "(auth)"` → `router.replace("/")`;
 * - the root layout calls `useOnboardingRedirect()` first, so onboarding wins
 *   (a signed-out first-time user sees onboarding, then sign-in).
 */
export function useAuthRedirect(): void {}
