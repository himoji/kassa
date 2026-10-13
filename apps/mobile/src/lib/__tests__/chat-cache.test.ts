import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { storage } from "@/lib/storage";

import { clearChatCache, readCachedMessages, writeCachedMessages } from "../chat-cache";

// Node's AES-256-GCM stands in for expo-crypto's native module: same sealed layout (iv|data|tag).
jest.mock("expo-crypto", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  class AESEncryptionKey {
    raw: Uint8Array;
    constructor(raw: Uint8Array) {
      this.raw = raw;
    }
    static import(bytes: Uint8Array) {
      return Promise.resolve(new AESEncryptionKey(bytes));
    }
  }
  class AESSealedData {
    buf: Buffer;
    constructor(buf: Buffer) {
      this.buf = buf;
    }
    static fromCombined(b64: string) {
      return new AESSealedData(Buffer.from(b64, "base64"));
    }
    combined() {
      return Promise.resolve(this.buf.toString("base64"));
    }
  }
  return {
    getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
    randomUUID: () => nodeCrypto.randomUUID(),
    AESEncryptionKey,
    AESSealedData,
    aesEncryptAsync: (plain: Uint8Array, key: AESEncryptionKey) => {
      const iv = nodeCrypto.randomBytes(12);
      const c = nodeCrypto.createCipheriv("aes-256-gcm", key.raw, iv);
      const data = Buffer.concat([c.update(plain), c.final()]);
      return Promise.resolve(new AESSealedData(Buffer.concat([iv, data, c.getAuthTag()])));
    },
    aesDecryptAsync: (sealed: AESSealedData, key: AESEncryptionKey) => {
      const iv = sealed.buf.subarray(0, 12);
      const tag = sealed.buf.subarray(sealed.buf.length - 16);
      const d = nodeCrypto.createDecipheriv("aes-256-gcm", key.raw, iv);
      d.setAuthTag(tag);
      const out = Buffer.concat([
        d.update(sealed.buf.subarray(12, sealed.buf.length - 16)),
        d.final(),
      ]);
      return Promise.resolve(new Uint8Array(out));
    },
  };
});

const msg = (n: number) => ({
  id: `m${n}`,
  role: "user",
  parts: [{ type: "text", text: `secret ${n}` }],
});

describe("chat-cache", () => {
  beforeEach(async () => {
    await clearChatCache();
  });

  it("round-trips messages and stores only ciphertext", async () => {
    await writeCachedMessages("c1", [msg(1), msg(2)]);
    const raw = await storage.getItem("chat-cache:c1");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("secret");
    expect(Buffer.from(raw!, "base64").toString("utf8")).not.toContain("secret");
    await expect(readCachedMessages("c1")).resolves.toEqual([msg(1), msg(2)]);
  });

  it("keeps the last 50 messages", async () => {
    await writeCachedMessages(
      "c1",
      Array.from({ length: 60 }, (_, i) => msg(i))
    );
    const out = await readCachedMessages<{ id: string }>("c1");
    expect(out).toHaveLength(50);
    expect(out[0]!.id).toBe("m10");
  });

  it("returns [] for unknown, tampered or key-less caches", async () => {
    await expect(readCachedMessages("nope")).resolves.toEqual([]);
    await writeCachedMessages("c1", [msg(1)]);
    const raw = (await storage.getItem("chat-cache:c1"))!;
    const bytes = Buffer.from(raw, "base64");
    bytes[20] = bytes[20]! ^ 0xff;
    await storage.setItem("chat-cache:c1", bytes.toString("base64"));
    await expect(readCachedMessages("c1")).resolves.toEqual([]);
  });

  it("clearChatCache drops entries and the key", async () => {
    await writeCachedMessages("c1", [msg(1)]);
    const stored = (await storage.getItem("chat-cache:c1"))!;
    await clearChatCache();
    await expect(storage.getItem("chat-cache:c1")).resolves.toBeNull();
    // A re-created key cannot open the old ciphertext.
    await storage.setItem("chat-cache:c1", stored);
    await writeCachedMessages("c2", [msg(2)]);
    await expect(readCachedMessages("c1")).resolves.toEqual([]);
  });
});
