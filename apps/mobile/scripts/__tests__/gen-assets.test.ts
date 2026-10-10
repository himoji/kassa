/** @jest-environment node */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  ADAPTIVE_SCALE,
  FAVICON_SIZE,
  ICON_SIZE,
  SPLASH_SIZE,
  generateAssets,
  planAssets,
} from "../lib/gen-assets.ts";

const config = { brand: { primary: "#171717", accent: "#2563eb", radius: 12, font: "Inter" } };

describe("planAssets", () => {
  it("lists every app.config.ts asset with its size", () => {
    const plan = planAssets(config);
    expect(plan.map((a) => [a.path, a.width, a.height, a.kind])).toEqual([
      ["assets/images/icon.png", ICON_SIZE, ICON_SIZE, "icon"],
      ["assets/images/android-icon-foreground.png", ICON_SIZE, ICON_SIZE, "android-foreground"],
      ["assets/images/android-icon-background.png", ICON_SIZE, ICON_SIZE, "android-background"],
      ["assets/images/android-icon-monochrome.png", ICON_SIZE, ICON_SIZE, "android-monochrome"],
      ["assets/images/splash-icon.png", SPLASH_SIZE, SPLASH_SIZE, "splash"],
      ["assets/images/favicon.png", FAVICON_SIZE, FAVICON_SIZE, "favicon"],
    ]);
  });

  it("flattens icon + android background onto brand.primary, keeps the rest transparent", () => {
    const byKind = Object.fromEntries(planAssets(config).map((a) => [a.kind, a.background]));
    expect(byKind.icon).toBe("#171717");
    expect(byKind["android-background"]).toBe("#171717");
    expect(byKind["android-foreground"]).toBeUndefined();
    expect(byKind["android-monochrome"]).toBeUndefined();
    expect(byKind.splash).toBeUndefined();
    expect(byKind.favicon).toBeUndefined();
  });

  it("rejects a missing or non-hex brand.primary", () => {
    expect(() => planAssets({})).toThrow(/brand\.primary/);
    expect(() => planAssets({ brand: { primary: "blue" } })).toThrow(/brand\.primary/);
  });
});

describe("generateAssets", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "readynative-assets-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** `stats()` reads the input, not the pipeline: crop to a buffer first. */
  async function regionStats(file: string, left: number, top: number, size = 8) {
    const crop = await sharp(file).extract({ left, top, width: size, height: size }).toBuffer();
    return sharp(crop).stats();
  }

  /** 64×64 PNG: opaque red square in the middle (50%), transparent border. */
  async function writeSource(rel = "assets/brand/icon.png", size = 64): Promise<string> {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const inner = await sharp({
      create: { width: size / 2, height: size / 2, channels: 4, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: inner, gravity: "centre" }])
      .png()
      .toFile(abs);
    return abs;
  }

  it("writes every planned asset at the planned size", async () => {
    await writeSource();
    const { written, warnings } = await generateAssets({ root, config });

    const plan = planAssets(config);
    expect(written).toEqual(plan.map((a) => path.join(root, a.path)));
    // 64px source → upscaling warning, but generation still succeeds.
    expect(warnings).toHaveLength(1);

    for (const asset of plan) {
      const meta = await sharp(path.join(root, asset.path)).metadata();
      expect([asset.path, meta.width, meta.height]).toEqual([
        asset.path,
        asset.width,
        asset.height,
      ]);
    }
  });

  it("flattens the icon (no transparent pixels) and keeps the foreground transparent outside 66%", async () => {
    await writeSource();
    await generateAssets({ root, config });

    const icon = await sharp(path.join(root, "assets/images/icon.png")).stats();
    expect(icon.channels[3]?.min).toBe(255);

    const fg = path.join(root, "assets/images/android-icon-foreground.png");
    const corner = await regionStats(fg, 0, 0);
    expect(corner.channels[3]?.max).toBe(0);
    const centre = Math.round(ICON_SIZE / 2);
    const middle = await regionStats(fg, centre - 4, centre - 4);
    expect(middle.channels[3]?.min).toBe(255);
    // The source square spans 50% of the 66% box: opaque just inside 16.5% of the canvas
    // from the centre, transparent just outside it.
    const edge = Math.round(ICON_SIZE * ADAPTIVE_SCALE * 0.25);
    const inside = await regionStats(fg, centre - edge + 8, centre - 4);
    expect(inside.channels[3]?.min).toBe(255);
    const outside = await regionStats(fg, centre - edge - 16, centre - 4);
    expect(outside.channels[3]?.max).toBe(0);
  });

  it("renders the monochrome icon as a white silhouette", async () => {
    await writeSource();
    await generateAssets({ root, config });
    const centre = Math.round(ICON_SIZE / 2);
    const file = path.join(root, "assets/images/android-icon-monochrome.png");
    const mono = await regionStats(file, centre - 4, centre - 4);
    expect(mono.channels.slice(0, 3).map((c) => c.min)).toEqual([255, 255, 255]);
    expect(mono.channels[3]?.min).toBe(255);
    const corner = await regionStats(file, 0, 0);
    expect(corner.channels[3]?.max).toBe(0);
  });

  it("honours --source and rejects non-square input", async () => {
    const custom = await writeSource("brand/custom.png");
    const { written } = await generateAssets({ root, source: custom, config });
    expect(written).toHaveLength(6);

    const wide = path.join(root, "wide.png");
    await sharp({ create: { width: 64, height: 32, channels: 4, background: "#00ff00" } })
      .png()
      .toFile(wide);
    await expect(generateAssets({ root, source: wide, config })).rejects.toThrow(/square/);
  });

  it("fails clearly when the source is missing", async () => {
    await expect(generateAssets({ root, config })).rejects.toThrow(/Source image not found/);
  });
});
