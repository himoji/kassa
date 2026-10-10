/**
 * App icon / splash / favicon generation from one brand source image.
 *
 * Input: `assets/brand/icon.png` (square, ideally ≥1024 px, alpha optional).
 * Background: `brand.primary` from `readynative.config.ts`. Output goes to
 * `assets/images/*` (the paths `app.config.ts` references).
 *
 * `planAssets` is pure (no sharp) so tests can check sizes/paths cheaply;
 * `generateAssets` does the image work. Imports use explicit `.ts` extensions
 * because the CLI runs under Node (see scripts/gen-assets.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp, { type Sharp } from "sharp";

export type AssetKind =
  | "icon"
  | "android-foreground"
  | "android-background"
  | "android-monochrome"
  | "splash"
  | "favicon";

export interface PlannedAsset {
  /** Root-relative path. */
  path: string;
  width: number;
  height: number;
  kind: AssetKind;
  /** Opaque fill (flattened) - absent for transparent outputs. */
  background?: string;
}

export interface AssetsConfigShape {
  brand?: { primary?: string };
}

export const DEFAULT_SOURCE = "assets/brand/icon.png";
export const ICON_SIZE = 1024;
export const SPLASH_SIZE = 512;
export const FAVICON_SIZE = 48;
/** Android adaptive icon safe zone: the logo occupies 66% of the 108dp canvas. */
export const ADAPTIVE_SCALE = 0.66;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function brandPrimary(config: unknown): string {
  const primary = (config as AssetsConfigShape | undefined)?.brand?.primary;
  if (typeof primary !== "string" || !HEX_COLOR.test(primary.trim())) {
    throw new Error(
      `readynative.config.ts brand.primary must be a hex colour (got ${JSON.stringify(primary)})`
    );
  }
  return primary.trim();
}

/** Pure: what `generateAssets` will write, given the loaded readynative config. */
export function planAssets(config: unknown): PlannedAsset[] {
  const primary = brandPrimary(config);
  const square = (size: number) => ({ width: size, height: size });
  return [
    { path: "assets/images/icon.png", ...square(ICON_SIZE), kind: "icon", background: primary },
    {
      path: "assets/images/android-icon-foreground.png",
      ...square(ICON_SIZE),
      kind: "android-foreground",
    },
    {
      path: "assets/images/android-icon-background.png",
      ...square(ICON_SIZE),
      kind: "android-background",
      background: primary,
    },
    {
      path: "assets/images/android-icon-monochrome.png",
      ...square(ICON_SIZE),
      kind: "android-monochrome",
    },
    { path: "assets/images/splash-icon.png", ...square(SPLASH_SIZE), kind: "splash" },
    { path: "assets/images/favicon.png", ...square(FAVICON_SIZE), kind: "favicon" },
  ];
}

export interface GenerateAssetsOptions {
  root: string;
  /** Source PNG; relative paths resolve against `root`. Default: assets/brand/icon.png. */
  source?: string;
  /** Loaded `readynative.config.ts` default export. */
  config: unknown;
}

export interface GenerateAssetsResult {
  /** Absolute paths written, in plan order. */
  written: string[];
  warnings: string[];
}

/** Source scaled to `size` (contain, transparent letterbox), RGBA PNG buffer. */
async function scaledSource(source: Buffer, size: number): Promise<Buffer> {
  return sharp(source)
    .ensureAlpha()
    .resize(size, size, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

/** Transparent `size`² canvas with `content` composited in the centre. */
function centeredOnTransparent(content: Buffer, size: number): Sharp {
  return sharp({
    create: { width: size, height: size, channels: 4, background: TRANSPARENT },
  })
    .composite([{ input: content, gravity: "centre" }])
    .png();
}

async function renderAsset(asset: PlannedAsset, source: Buffer): Promise<Buffer> {
  const { width, height, kind } = asset;
  switch (kind) {
    case "icon":
      return sharp(source)
        .ensureAlpha()
        .resize(width, height, { fit: "contain", background: asset.background })
        .flatten({ background: asset.background })
        .png()
        .toBuffer();
    case "android-background":
      return sharp({
        create: { width, height, channels: 4, background: asset.background as string },
      })
        .png()
        .toBuffer();
    case "android-foreground": {
      const inner = await scaledSource(source, Math.round(width * ADAPTIVE_SCALE));
      return centeredOnTransparent(inner, width).toBuffer();
    }
    case "android-monochrome": {
      // White silhouette: the source alpha becomes the alpha of a solid white square.
      const innerSize = Math.round(width * ADAPTIVE_SCALE);
      const inner = await scaledSource(source, innerSize);
      const alpha = await sharp(inner).extractChannel("alpha").png().toBuffer();
      const silhouette = await sharp({
        create: { width: innerSize, height: innerSize, channels: 3, background: "#ffffff" },
      })
        .joinChannel(alpha)
        .png()
        .toBuffer();
      return centeredOnTransparent(silhouette, width).toBuffer();
    }
    case "splash":
    case "favicon":
      return scaledSource(source, width);
  }
}

export async function generateAssets(
  options: GenerateAssetsOptions
): Promise<GenerateAssetsResult> {
  const { root, config } = options;
  const sourcePath = path.resolve(root, options.source ?? DEFAULT_SOURCE);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Source image not found: ${sourcePath} (expected a square PNG ≥${ICON_SIZE}px)`
    );
  }
  const plan = planAssets(config);
  const source = fs.readFileSync(sourcePath);
  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height) throw new Error(`Cannot read image size: ${sourcePath}`);
  if (meta.width !== meta.height) {
    throw new Error(`Source must be square, got ${meta.width}×${meta.height}: ${sourcePath}`);
  }
  const warnings: string[] = [];
  if (meta.width < ICON_SIZE) {
    warnings.push(
      `Source is ${meta.width}px; ${ICON_SIZE}px or larger avoids upscaling (${sourcePath})`
    );
  }

  const written: string[] = [];
  for (const asset of plan) {
    const out = path.join(root, asset.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await renderAsset(asset, source));
    written.push(out);
  }
  return { written, warnings };
}

/** Loads `<root>/readynative.config.ts` the same way doctor does (dynamic import). */
export async function loadReadyNativeConfig(root: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path.join(root, "readynative.config.ts")).href)) as {
    default?: unknown;
  };
  return mod.default ?? mod;
}
