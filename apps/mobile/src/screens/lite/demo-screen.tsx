import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { DemoProofSection } from "@/components/demo-proof-section";

/** KassaLite Settings → "Demo & proof": the demo pages (evidence room, ledger check, simulated shops). */
export function LiteDemoScreen() {
  return (
    <ScrollScreen testID="lite-demo-screen">
      <DemoProofSection />
    </ScrollScreen>
  );
}
