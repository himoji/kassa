import { describe, expect, it } from "@jest/globals";

import { apiBaseUrl, defaultApiOrigin } from "../config";

describe("defaultApiOrigin", () => {
  it("keeps the configured URL on native (no page) and on localhost pages", () => {
    expect(defaultApiOrigin("http://localhost:4000", undefined)).toBe("http://localhost:4000");
    expect(defaultApiOrigin("http://localhost:4000", "localhost")).toBe("http://localhost:4000");
    expect(defaultApiOrigin("http://localhost:4000", "127.0.0.1")).toBe("http://localhost:4000");
  });

  it("uses the page origin when a tunnel page is configured with a loopback API (dev:all)", () => {
    expect(defaultApiOrigin("http://localhost:4000", "abc-def.trycloudflare.com")).toBeUndefined();
    expect(defaultApiOrigin("http://127.0.0.1:4000/api", "kassa.example")).toBeUndefined();
    expect(apiBaseUrl(defaultApiOrigin("http://localhost:4000", "abc-def.trycloudflare.com"))).toBe(
      "/api"
    );
  });

  it("keeps a non-loopback API URL everywhere", () => {
    expect(defaultApiOrigin("https://api.kassa.example", "kassa.example")).toBe(
      "https://api.kassa.example"
    );
    expect(defaultApiOrigin("http://192.168.1.20:4000", "192.168.1.20")).toBe(
      "http://192.168.1.20:4000"
    );
  });

  it("leaves an unset URL unset", () => {
    expect(defaultApiOrigin(undefined, "kassa.example")).toBeUndefined();
  });
});
