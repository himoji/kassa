/* eslint-disable @typescript-eslint/no-require-imports */
import { describe, expect, it } from "@jest/globals";
import { formatMoney } from "@kassa/shared";

import { formatAmount, formatBps, formatDate } from "@/lib/format";

// Node built-ins via require: the static check reads the app's sources, it does not import them.
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const SRC = path.resolve(__dirname, "..");
const ROOT = path.resolve(SRC, "..");
const SCANNED_DIRS = ["screens", "components"].map((dir) => path.join(SRC, dir));

/** A division by 100 or a toFixed() on a line naming a minor-unit amount is hand-rolled money. */
const HAND_ROLLED = /\/\s*100\b|toFixed\(/;

function collectSources(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") collectSources(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

describe("formatAmount", () => {
  it("delegates to the shared formatMoney for supported currencies", () => {
    expect(formatAmount(123456, "KZT", "en-US")).toBe(formatMoney(123456, "KZT", "en-US"));
  });

  it("uses the currency's ISO exponent", () => {
    expect(formatAmount(180000_00, "HUF", "en-US")).toContain("180,000.00");
    expect(formatAmount(250, "EUR", "de-DE")).toContain("2,50");
  });

  it("shows the raw code for unknown currencies without throwing", () => {
    expect(() => formatAmount(5, "XYZ", "en")).not.toThrow();
    expect(formatAmount(5, "XYZ", "en")).toContain("XYZ");
  });
});

describe("formatDate", () => {
  it("formats a date-only string on its own day (no timezone shift)", () => {
    expect(formatDate("2026-10-31", "en-US")).toBe("Oct 31, 2026");
  });
});

describe("formatBps", () => {
  it("renders basis points as a localised percentage", () => {
    expect(formatBps(400, "en-US")).toBe("4%");
  });
});

describe("no hand-rolled minor-unit conversion", () => {
  it("no screen or component divides or toFixed()s a Minor amount", () => {
    const files: string[] = [];
    for (const dir of SCANNED_DIRS) collectSources(dir, files);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (line.includes("Minor") && HAND_ROLLED.test(line)) offenders.push(`${rel}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
