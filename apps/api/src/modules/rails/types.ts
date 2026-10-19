/* Rail interface (spec §11). */
import type { CanonicalOrder, OrderRail as RailId, PayeeKind, PaymentStatus } from "@kassa/shared";

import type { DbOrTx } from "../../db/client.ts";

export type ExecCtx = {
  db: DbOrTx;
  paymentId: string;
  approvalId: string;
  now: Date;
  payee: { id: string; name: string; kind: PayeeKind; account: string };
};

export type RailResult = { status: PaymentStatus; railRef: string; details?: Record<string, unknown>; reasonCodes?: string[] };

export interface Rail {
  id: RailId;
  execute(order: CanonicalOrder, ctx: ExecCtx): Promise<RailResult>;
}
