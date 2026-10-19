/**
 * KassaLite is a second build of this app (`APP_VARIANT=lite`, docs/guide/kassalite.md): same JS code base,
 * its own routes (`src/app-lite`), a free-team-safe native config. `app.config.ts` records the variant
 * in `extra.appVariant`; code that must behave differently reads it here.
 */
import Constants from "expo-constants";

export function isLiteBuild(): boolean {
  return (
    (Constants.expoConfig?.extra as { appVariant?: string } | undefined)?.appVariant === "lite"
  );
}
