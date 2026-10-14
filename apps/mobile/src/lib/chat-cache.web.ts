/**
 * Web: no offline message cache. Chat content is never written to localStorage; the server
 * history is loaded on every visit. (Native: `./chat-cache.ts`, encrypted.)
 */
export const CHAT_CACHE_LIMIT = 50;

export async function readCachedMessages<T = unknown>(_conversationId: string): Promise<T[]> {
  return [];
}

export async function writeCachedMessages(
  _conversationId: string,
  _messages: readonly unknown[]
): Promise<void> {}

export async function removeCachedMessages(_conversationId: string): Promise<void> {}

export async function clearChatCache(): Promise<void> {}
