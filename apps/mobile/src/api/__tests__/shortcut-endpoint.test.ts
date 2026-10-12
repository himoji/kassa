import { describe, expect, it } from "@jest/globals";

import { shortcutEndpoint } from "../hooks/shortcut";

describe("shortcutEndpoint", () => {
  it("uses an absolute API base as is", () => {
    expect(shortcutEndpoint("https://kassa.example/api")).toBe(
      "https://kassa.example/api/capture/shortcut"
    );
    expect(shortcutEndpoint("http://192.168.1.20:4000/api/")).toBe(
      "http://192.168.1.20:4000/api/capture/shortcut"
    );
  });

  it("prefixes the page origin for a same-origin web build", () => {
    expect(shortcutEndpoint("/api", "https://kassa-phone.example.com")).toBe(
      "https://kassa-phone.example.com/api/capture/shortcut"
    );
  });

  it("returns null when no absolute address is known", () => {
    expect(shortcutEndpoint("/api", "null")).toBeNull();
  });
});
