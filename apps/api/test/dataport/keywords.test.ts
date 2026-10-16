/*
 * Dictionary keywords for Kazakh, Russian and Hungarian chains (fixtures/merchants.json). The examples are shaped like
 * real statement descriptions (public chain names only). On the three real statements of the 2026-10-15 run they move
 * 251 of 680 "other" rows into a category; most of the rest are bare "KaspiQR" payments with no merchant.
 */
import { describe, expect, it } from "vitest";

import { categoryFromKeywords } from "../../src/modules/capture/categorize.ts";
import { normalizeMerchant } from "../../src/modules/capture/normalize.ts";

const cat = (raw: string) => categoryFromKeywords(normalizeMerchant(raw));

describe("chain keywords (KZ, RU, HU)", () => {
  it.each([
    ["YANDEX.GO", "transport"],
    ["Билет Avtobys. Жол ақысын төлеу", "transport"],
    ["SIMPLEP*BudapestGO app", "transport"],
    ["MOL TOLTOALLOMAS", "transport"],
    ["Супермаркет GALMART", "groceries"],
    ["SMALL", "groceries"],
    ["VEGYES DISZKONT", "groceries"],
    ["CBA PRIMA", "groceries"],
    ["JETPAY.KZ*DODO.KZ", "eating_out"],
    ["JETPAY*DRINKIT", "eating_out"],
    ["Кофейня у дома", "eating_out"],
    ["TOWER PUB", "eating_out"],
    ["Bisztró és étterem", "eating_out"],
    ["Grande Pharm", "health"],
    ["BENU Gyógyszertár", "health"],
    ["KINO.KZ", "entertainment"],
    ['TOO "KASPI MAGAZIN"', "shopping"],
    ["SULPAK", "shopping"],
    ["MELOMAN", "books"],
    ["ALSECO", "utilities"],
    ["Collegeboard*Profile", "tuition"],
  ])("%s → %s", (raw, expected) => {
    expect(cat(raw)).toBe(expected);
  });

  it("a word inside another word does not match", () => {
    expect(cat("BARION PAYMENT")).toBeNull();
    expect(cat("MOLNAR ES TARSA")).toBeNull();
  });
});
