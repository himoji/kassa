/** Emoji shown next to a budget category (the app's categories; anything else gets a coin). */
const EMOJI: Record<string, string> = {
  groceries: "🛒",
  eating_out: "🍽️",
  transport: "🚌",
  rent: "🏠",
  tuition: "🎓",
  insurance: "🛡️",
  utilities: "💡",
  shopping: "🛍️",
  health: "💊",
  fun: "🎉",
  entertainment: "🎬",
  travel: "✈️",
  subscriptions: "📱",
  savings: "💰",
  other: "📦",
};

export function categoryEmoji(category: string): string {
  return EMOJI[category] ?? "🪙";
}
