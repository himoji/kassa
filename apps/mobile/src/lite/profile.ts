/** Who this iPhone is paired as (display name only; the session itself is in the Keychain). */
import { storage } from "@/lib/storage";

const KEY = "kassalite:displayName";

export async function loadDisplayName(): Promise<string | null> {
  try {
    return await storage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function saveDisplayName(name: string): Promise<void> {
  await storage.setItem(KEY, name);
}

export async function clearDisplayName(): Promise<void> {
  await storage.removeItem(KEY);
}
