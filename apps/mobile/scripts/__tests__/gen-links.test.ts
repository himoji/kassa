/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AASA_PATH,
  ASSETLINKS_PATH,
  aasa,
  assetlinks,
  checkLinks,
  renderLinks,
  writeLinks,
  type LinksConfigInput,
} from "../lib/gen-links";

const placeholder: LinksConfigInput = {
  app: { ios: { bundleId: "com.acme.app" }, android: { package: "com.acme.app" } },
  links: { domain: "", appleTeamId: "", androidCertFingerprints: [] },
};

const filled: LinksConfigInput = {
  app: { ios: { bundleId: "io.acme.ios" }, android: { package: "io.acme.android" } },
  links: {
    domain: "acme.io",
    appleTeamId: "ABCDE12345",
    androidCertFingerprints: ["AA:BB:CC", "DD:EE:FF"],
  },
};

describe("aasa / assetlinks", () => {
  it("lists prod, preview and dev ids (same suffix rule as app.config.ts)", () => {
    const ids = [
      "ABCDE12345.io.acme.ios",
      "ABCDE12345.io.acme.ios.preview",
      "ABCDE12345.io.acme.ios.dev",
    ];
    const out = aasa(filled);
    expect(out.applinks.details).toEqual([{ appIDs: ids, components: [{ "/": "/*" }] }]);
    expect(out.webcredentials.apps).toEqual(ids);

    const links = assetlinks(filled);
    expect(links.map((l) => l.target.package_name)).toEqual([
      "io.acme.android",
      "io.acme.android.preview",
      "io.acme.android.dev",
    ]);
    for (const l of links) {
      expect(l.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
      expect(l.target.namespace).toBe("android_app");
      expect(l.target.sha256_cert_fingerprints).toEqual(["AA:BB:CC", "DD:EE:FF"]);
    }
  });

  it("uses visible placeholders when team id / fingerprints are empty", () => {
    expect(aasa(placeholder).applinks.details[0].appIDs).toEqual([
      "TEAM_ID.com.acme.app",
      "TEAM_ID.com.acme.app.preview",
      "TEAM_ID.com.acme.app.dev",
    ]);
    expect(assetlinks(placeholder)[0].target.sha256_cert_fingerprints).toEqual([
      "SHA256_FINGERPRINT",
    ]);
  });
});

describe("renderLinks", () => {
  it("emits both .well-known files as 2-space JSON with a trailing newline", async () => {
    const files = await renderLinks(filled);
    const placeholders = await renderLinks(placeholder);
    expect(Object.keys(files).sort()).toEqual([AASA_PATH, ASSETLINKS_PATH].sort());
    for (const content of Object.values(files)) {
      expect(content.endsWith("\n")).toBe(true);
      expect(content).toContain("\n  ");
      expect(() => JSON.parse(content)).not.toThrow();
    }
    expect(JSON.parse(files[AASA_PATH])).toEqual(aasa(filled));
    expect(JSON.parse(files[ASSETLINKS_PATH])).toEqual(assetlinks(filled));
    expect(files[AASA_PATH]).not.toContain("TEAM_ID");
    expect(placeholders[AASA_PATH]).toContain("TEAM_ID.com.acme.app");
    expect(placeholders[ASSETLINKS_PATH]).toContain("SHA256_FINGERPRINT");
  });
});

describe("writeLinks / checkLinks", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "readynative-gen-links-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reports missing files, then round-trips after a write", async () => {
    expect(await checkLinks(root, filled)).toEqual([
      { file: AASA_PATH, reason: "missing" },
      { file: ASSETLINKS_PATH, reason: "missing" },
    ]);

    const written = await writeLinks(root, filled);
    expect(written.sort()).toEqual([AASA_PATH, ASSETLINKS_PATH].sort());
    expect(fs.readFileSync(path.join(root, AASA_PATH), "utf8")).toBe(
      (await renderLinks(filled))[AASA_PATH]
    );
    expect(await checkLinks(root, filled)).toEqual([]);

    // Config changed → drift; rewriting clears it.
    const changed = { ...filled, links: { ...filled.links, appleTeamId: "ZZZZZ99999" } };
    expect(await checkLinks(root, changed)).toEqual([{ file: AASA_PATH, reason: "differs" }]);
    await writeLinks(root, changed);
    expect(await checkLinks(root, changed)).toEqual([]);
  });
});
