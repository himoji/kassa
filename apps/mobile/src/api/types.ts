import type { SessionTokens } from "@kassa/shared";

/** Where session tokens live: the keystore on native, nowhere (httpOnly cookie) on web. */
export interface TokenStore {
  kind: "native" | "web";
  load(): Promise<SessionTokens | null>;
  save(tokens: SessionTokens): Promise<void>;
  clear(): Promise<void>;
}
