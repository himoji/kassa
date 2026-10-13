import { LiteRoot } from "@/screens/lite/lite-root";

export { ErrorBoundary } from "@/components/error-boundary";

/** KassaLite routes (APP_VARIANT=lite; the expo-router plugin `root` points here, see app.config.ts). */
export default function LiteLayout() {
  return <LiteRoot />;
}
