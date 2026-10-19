import { RecipientCategory } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";

import { ScrollScreen } from "@/components/kassa/scroll-screen";

import { AddPayeeForm } from "./add-payee-form";

/**
 * Add a recipient: a modal screen, not a bottom sheet, so the long form scrolls and every field and the Save button
 * stay above the keyboard (ScrollScreen is keyboard-aware). `?category=RENT` skips the category step.
 */
export function AddPayeeScreen() {
  const params = useLocalSearchParams<{ category?: string }>();
  const parsed = RecipientCategory.safeParse(params.category);
  const close = () => (router.canGoBack() ? router.back() : router.replace("/payees"));
  return (
    <ScrollScreen>
      <AddPayeeForm initialCategory={parsed.success ? parsed.data : null} onClose={close} />
    </ScrollScreen>
  );
}
