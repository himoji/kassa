/*
 * Fictitious bank statements for the demo recording (Dana, the demo persona): six months of a Kazakh card account in
 * KZT and a Hungarian card in HUF. Money from home is irregular on purpose (one large transfer, one missed month),
 * there is a one-off tuition payment and an own transfer between the two accounts, so the import shows what it
 * learns. Every name, account and amount is made up. `bun scripts/demo-video/statements.ts <dir>` writes two CSVs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A small seeded generator, so every recording uploads the same files. */
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

const pad = (n: number) => String(n).padStart(2, "0");
const day = (m: number, d: number) => `2026-${pad(m)}-${pad(d)}`;

export function demoStatements(): { name: string; text: string }[] {
  const r = rng(7);
  const kzt: string[] = ["Date,Description,Amount,Currency"];
  const huf: string[] = ["Date,Description,Amount,Currency"];
  // Money from home: most months, a large one in August (it pays the tuition), nothing in July.
  const fromHome: Record<number, number> = { 4: 520_000, 5: 480_000, 6: 540_000, 8: 1_900_000, 9: 500_000 };
  for (let m = 4; m <= 9; m++) {
    if (fromHome[m]) kzt.push(`${day(m, 3)},Transfer from Aigerim S.,${fromHome[m]}.00,KZT`);
    kzt.push(`${day(m, 12)},KCELL mobile,-3990.00,KZT`);
    kzt.push(`${day(m, 15)},Transfer to own account Example Card HU,-420000.00,KZT`);
    huf.push(`${day(m, 16)},Top-up from own account Example Card KZ,${Math.round(420000 / 1.55)}.00,HUF`);
    huf.push(`${day(m, 1)},Rent Landlord in Budapest,-180000.00,HUF`);
    for (let d = 2; d <= 28; d += 1 + Math.floor(r() * 3)) {
      huf.push(`${day(m, d)},SPAR MAGYARORSZAG,-${(2000 + Math.floor(r() * 9000)).toFixed(2)},HUF`);
      if (r() < 0.5) huf.push(`${day(m, d)},BKK BUDAPEST,-${(450 + Math.floor(r() * 600)).toFixed(2)},HUF`);
      if (r() < 0.3) huf.push(`${day(m, d)},Coffee Shop in Budapest,-${(900 + Math.floor(r() * 1500)).toFixed(2)},HUF`);
    }
  }
  kzt.push(`${day(8, 20)},University in Budapest tuition,-1250000.00,KZT`);
  return [
    { name: "example-kz-bank-apr-sep-2026.csv", text: kzt.join("\n") + "\n" },
    { name: "example-hu-card-apr-sep-2026.csv", text: huf.join("\n") + "\n" },
  ];
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "demo-statements";
  mkdirSync(dir, { recursive: true });
  for (const f of demoStatements()) writeFileSync(join(dir, f.name), f.text);
  console.log(`wrote ${demoStatements().length} statements to ${dir}`);
}
