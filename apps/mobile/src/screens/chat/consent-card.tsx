import { useState } from "react";

import { api } from "@/api/client";
import { Box, Button, Card, Text } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

import type { ConsentNeeded } from "./consent";

/** 403 AI_CONSENT_REQUIRED / PIPL_CONSENT_REQUIRED: the notice and an explicit "I agree" (never silent). */
export function ConsentCard({ need, onGiven }: { need: ConsentNeeded; onGiven: () => void }) {
  const t = useKassaT();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pipl = need.code === "PIPL_CONSENT_REQUIRED";
  const agree = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await api.request(need.endpoint, { method: "POST", json: { consent: true } });
      haptics.selection();
      onGiven();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card>
      <Box gap={2}>
        <Text variant="heading">{t(pipl ? "chat:consent.piplTitle" : "chat:consent.aiTitle")}</Text>
        <Text>{t(pipl ? "chat:consent.piplBody" : "chat:consent.aiBody")}</Text>
        {need.noticeText ? <Text variant="caption">{need.noticeText}</Text> : null}
        {failed ? <Text color="destructive">{t("chat:consent.failed")}</Text> : null}
        <Button onPress={() => void agree()} disabled={saving}>
          {t("chat:consent.agree")}
        </Button>
      </Box>
    </Card>
  );
}
