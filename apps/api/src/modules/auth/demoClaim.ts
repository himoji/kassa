import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { demoState, users } from "../../db/schema.ts";
import { HttpProblem } from "../../http/problem.ts";
import { loadSeedData } from "../demo/seed.ts";

/**
 * The seeded demo account a `demoClaim` names: `true` = the seeded hero, a string = that seeded persona key (D-CN3,
 * seed `personas`). Used by the demo-claim registration and by the dev sign-in's demo mode.
 */
export async function demoClaimUserId(claim: true | string): Promise<string> {
  const db = getDb();
  const ds = (await db.select().from(demoState).where(eq(demoState.id, 1)))[0];
  if (!ds?.demoUserId) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Run the seed first");
  if (claim === true) return ds.demoUserId;
  const persona = (await loadSeedData()).personas?.find((p) => p.persona === claim);
  if (!persona) throw new HttpProblem(404, "DEMO_PERSONA_UNKNOWN", `No seeded demo persona "${claim}"`);
  const seeded = (await db.select({ id: users.id }).from(users).where(eq(users.id, persona.user.id)))[0];
  if (!seeded) throw new HttpProblem(409, "DEMO_NOT_SEEDED", "Seed with personas first (bun run seed, sim up, or demo reset)");
  return persona.user.id;
}
