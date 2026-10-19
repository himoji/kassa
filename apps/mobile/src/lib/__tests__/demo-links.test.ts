import { describe, expect, it } from "@jest/globals";

import { DEMO_LINKS, demoLinks, webOrigin } from "@/lib/demo-links";

describe("demo links", () => {
  it("derives the web origin from the API base URL", () => {
    expect(webOrigin("https://kassa-judge.vercel.app/api")).toBe("https://kassa-judge.vercel.app");
    expect(webOrigin("https://phone.example.com/api/")).toBe("https://phone.example.com");
    expect(webOrigin("http://192.168.1.20:8080/api")).toBe("http://192.168.1.20:8080");
  });

  it("uses the page origin for a relative base (web app on its own origin)", () => {
    expect(webOrigin("/api", "https://kassa-sand.vercel.app")).toBe(
      "https://kassa-sand.vercel.app"
    );
    expect(webOrigin("/api")).toBeNull();
    expect(webOrigin("/api", "file://x")).toBeNull();
  });

  it("builds every page on that origin", () => {
    const links = demoLinks("https://kassa-judge.vercel.app/api", { mock: true });
    expect(Object.fromEntries(links.map((l) => [l.id, l.url]))).toEqual({
      evidence: "https://kassa-judge.vercel.app/showcase/",
      ledger: "https://kassa-judge.vercel.app/showcase/#ledger",
      stage: "https://kassa-judge.vercel.app/mock/stage",
      tap: "https://kassa-judge.vercel.app/mock/stage/tap",
      wallet: "https://kassa-judge.vercel.app/mock/stage/wallet",
      till: "https://kassa-judge.vercel.app/mock/shop/bud/till",
      school: "https://kassa-judge.vercel.app/mock/schools/budapest/portal?studentId=KZ26-0417",
    });
  });

  it("leaves out the mock-world pages when the server is not a demo server", () => {
    const ids = demoLinks("https://kassa.example/api", { mock: false }).map((l) => l.id);
    expect(ids).toEqual(["evidence", "ledger"]);
    expect(DEMO_LINKS.filter((l) => !l.mock).map((l) => l.id)).toEqual(ids);
  });

  it("returns nothing without a usable origin", () => {
    expect(demoLinks("", { mock: true })).toEqual([]);
  });
});
