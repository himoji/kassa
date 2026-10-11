/**
 * Web keeps no tokens in JavaScript: the session is an httpOnly cookie (spec §8), so script
 * (and any XSS) cannot read it. Requests send `credentials: "include"`.
 */
import type { TokenStore } from "./types";

export const tokenStore: TokenStore = {
  kind: "web",
  load: async () => null,
  save: async () => {},
  clear: async () => {},
};
