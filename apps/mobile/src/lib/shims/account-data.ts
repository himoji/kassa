/**
 * No-op server-side data deletion (contract 5). Replaced by `backend/api-routes`, whose
 * `deleteServerData()` asks `/api/privacy/delete` to erase the user in the third-party
 * services the server has keys for. Without API routes there is no server to ask: the
 * auth module's `deleteAccount()` is all account deletion does.
 */
/** Resolves when the server erased the signed-in user's third-party data (here: nothing to do). */
export function deleteServerData(): Promise<void> {
  return Promise.resolve();
}
