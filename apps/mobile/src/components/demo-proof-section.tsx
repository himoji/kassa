/**
 * Settings → "Demo & proof": the web pages a phone demo needs (evidence room, ledger check, the Stage, the shop
 * till, the QR wallet, the school portal), opened in the in-app browser (a new tab on web). Shown in KassaLite, in
 * dev builds and against a demo server (GET /auth/demo `enabled`, which is also what the judge build runs); never in
 * production. The mock-world pages only appear when the server runs the demo world. URLs: lib/demo-links.ts.
 */
import { api } from "@/api/client";
import { useDemoAvailability } from "@/api/hooks/auth";
import { RowGroup } from "@/components/row-group";
import { Icon, Row } from "@/components/ui";
import { openUrl } from "@/lib/browser";
import { demoLinks } from "@/lib/demo-links";
import { useKassaT } from "@/lib/i18n";
import { isLiteBuild } from "@/lite/variant";

export function DemoProofSection() {
  const t = useKassaT();
  const demo = useDemoAvailability();
  const demoServer = demo.data?.enabled === true;
  if (!(isLiteBuild() || __DEV__ || demoServer)) return null;
  const pageOrigin = (globalThis as { location?: { origin?: string } }).location?.origin;
  const links = demoLinks(api.baseUrl, { mock: demoServer || __DEV__, pageOrigin });
  if (links.length === 0) return null;
  return (
    <RowGroup title={t("evidence:links.title")} footer={t("evidence:links.footer")} icons>
      {links.map((l) => (
        <Row
          key={l.id}
          leading={<Icon name={l.icon} fallback={l.fallback} size={20} color="foreground" />}
          title={t(`evidence:links.${l.id}.title`)}
          subtitle={t(`evidence:links.${l.id}.subtitle`)}
          onPress={() => void openUrl(l.url)}
          testID={`demo-link-${l.id}`}
        />
      ))}
    </RowGroup>
  );
}
