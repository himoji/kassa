/* Rail registry (spec §11). */
import type { Rail as RailId } from "@kassa/shared";

import { handoffRail } from "./handoff.ts";
import { issuingRail } from "./issuing.ts";
import { mockBankRail } from "./mockBank.ts";
import { payInPlaceRail } from "./payInPlace.ts";
import type { Rail } from "./types.ts";

const RAILS: Record<RailId, Rail> = {
  CARD_ISSUING: issuingRail,
  BANK_TRANSFER: mockBankRail,
  HANDOFF: handoffRail,
  PAY_IN_PLACE: payInPlaceRail,
};

let overrides: Partial<Record<RailId, Rail>> = {};

export function railFor(id: RailId): Rail {
  return overrides[id] ?? RAILS[id];
}

/** Tests: replace rails (e.g. a stub bank). */
export function setRailOverridesForTests(o: Partial<Record<RailId, Rail>>): void {
  overrides = o;
}

export type { ExecCtx, Rail, RailResult } from "./types.ts";
