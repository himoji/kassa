/*
 * R15: USER_KEK came from env with no way to rotate it. Per-user DEKs are now wrapped through a KeyProvider (env
 * provider = the previous behaviour), and scripts/rotate-kek.ts re-wraps every user_keys row from the old KEK to the
 * new one in one transaction. After a rotation every sealed field still decrypts, under the new KEK only.
 * NIST SP 800-57 Part 1 Rev. 5 §5.3 (cryptoperiods), §8.2.3 (re-wrapping under a new key).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rotateKek } from "../../scripts/rotate-kek.ts";
import { getDb } from "../../src/db/client.ts";
import { userKeys } from "../../src/db/schema.ts";
import { env, resetEnvCache, setEnvForTests } from "../../src/env.ts";
import { clearDekCache, envKeyProvider, kekId, openPii, rewrapUserKeys, sealPii, setKeyProvider, shredUserKey } from "../../src/modules/privacy/keys.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

const t = useTestDb();
const newKek = () => randomBytes(32).toString("base64");

/** Two users with sealed fields and one erased (shredded) user, all under the current KEK. */
async function seedKeys() {
  const a = (await createUserWithPasskey()).userId;
  const b = (await createUserWithPasskey()).userId;
  const erased = (await createUserWithPasskey()).userId;
  const sealedA = await sealPii(a, { name: "Test Person A", iban: "HU00 0000 0000 0000" });
  const sealedB = await sealPii(b, { name: "Test Person B" });
  await sealPii(erased, { name: "Test Person C" });
  await shredUserKey(erased);
  if (!("pii" in sealedA) || !("pii" in sealedB)) throw new Error("expected sealed fields");
  return { a, b, erased, sealedA: sealedA.pii, sealedB: sealedB.pii };
}

/** A restart: no cached DEKs, the provider rebuilt from env. */
function restartWith(kek: string, previous?: string) {
  setEnvForTests({ USER_KEK: kek, ...(previous ? { USER_KEK_PREVIOUS: previous } : {}) });
  clearDekCache();
}

beforeEach(async () => {
  await t.reset();
});

afterEach(() => {
  setKeyProvider(null);
  resetEnvCache();
  clearDekCache();
});

describe("R15 KEK rotation", () => {
  it("re-wraps every row in one go; sealed fields decrypt under the new KEK only", async () => {
    const oldKek = env().USER_KEK;
    const s = await seedKeys();
    const before = await getDb().select().from(userKeys);
    const to = envKeyProvider(newKek());

    const r = await rewrapUserKeys(envKeyProvider(oldKek), to);
    expect(r).toMatchObject({ total: 3, rewrapped: 2, alreadyCurrent: 0, shredded: 1, dryRun: false, toKekId: to.kekId() });

    const after = await getDb().select().from(userKeys);
    for (const row of after.filter((x) => x.userId !== s.erased)) {
      expect(row.kekId).toBe(to.kekId());
      expect(row.wrappedDek).not.toBe(before.find((x) => x.userId === row.userId)?.wrappedDek);
    }
    expect(after.find((x) => x.userId === s.erased)).toMatchObject({ wrappedDek: null });

    setKeyProvider(to);
    expect(await openPii(s.a, s.sealedA)).toEqual({ name: "Test Person A", iban: "HU00 0000 0000 0000" });
    expect(await openPii(s.b, s.sealedB)).toEqual({ name: "Test Person B" });
    expect(await openPii(s.erased, "v1.x.y.z")).toBeNull();

    // The old KEK alone no longer opens anything.
    setKeyProvider(envKeyProvider(oldKek));
    await expect(openPii(s.a, s.sealedA)).rejects.toThrow(/does not hold/);
  });

  it("a re-run is a no-op; new keys made after the switch use the new KEK", async () => {
    const oldKek = env().USER_KEK;
    await seedKeys();
    const next = newKek();
    await rewrapUserKeys(envKeyProvider(oldKek), envKeyProvider(next));
    expect(await rewrapUserKeys(envKeyProvider(oldKek), envKeyProvider(next))).toMatchObject({ rewrapped: 0, alreadyCurrent: 2, shredded: 1 });
    restartWith(next);
    const late = (await createUserWithPasskey()).userId;
    await sealPii(late, { name: "Test Person D" });
    expect((await getDb().select().from(userKeys).where(eq(userKeys.userId, late)))[0]?.kekId).toBe(kekId());
  });

  it("during a rotation the API runs on the new KEK and still reads rows of the previous one", async () => {
    const oldKek = env().USER_KEK;
    const s = await seedKeys();
    const next = newKek();
    restartWith(next, oldKek);
    expect(await openPii(s.a, s.sealedA)).toMatchObject({ name: "Test Person A" });
    const fresh = (await createUserWithPasskey()).userId;
    const sealed = await sealPii(fresh, { name: "Test Person E" });
    expect((await getDb().select().from(userKeys).where(eq(userKeys.userId, fresh)))[0]?.kekId).toBe(envKeyProvider(next).kekId());
    // Rotation, then the previous KEK is removed: everything still opens.
    expect(await rewrapUserKeys(envKeyProvider(oldKek), envKeyProvider(next))).toMatchObject({ rewrapped: 2, alreadyCurrent: 1 });
    resetEnvCache();
    restartWith(next);
    expect(await openPii(s.b, s.sealedB)).toEqual({ name: "Test Person B" });
    expect(await openPii(fresh, (sealed as { pii: string }).pii)).toEqual({ name: "Test Person E" });
  });

  it("a wrong old KEK or a row under an unknown KEK changes nothing", async () => {
    await seedKeys();
    const before = await getDb().select().from(userKeys);
    await expect(rewrapUserKeys(envKeyProvider(newKek()), envKeyProvider(newKek()))).rejects.toThrow(/neither the old nor the new/);
    await expect(rewrapUserKeys(envKeyProvider(env().USER_KEK), envKeyProvider(env().USER_KEK))).rejects.toThrow(/same/);
    expect(await getDb().select().from(userKeys)).toEqual(before);
  });
});

describe("scripts/rotate-kek.ts", () => {
  it("--dry-run writes nothing; the real run re-wraps; output has counts and KEK ids, never a key", async () => {
    const oldKek = env().USER_KEK;
    const s = await seedKeys();
    const next = newKek();
    const before = await getDb().select().from(userKeys);
    const lines: string[] = [];
    const vars = { USER_KEK_PREVIOUS: oldKek, USER_KEK: next };

    const dry = await rotateKek(["--dry-run"], vars, (l) => lines.push(l));
    expect(dry).toMatchObject({ dryRun: true, rewrapped: 2 });
    expect(await getDb().select().from(userKeys)).toEqual(before);

    expect(await rotateKek([], vars, (l) => lines.push(l))).toMatchObject({ dryRun: false, rewrapped: 2, shredded: 1 });
    expect(lines.join("\n")).toMatch(/rows: 3; re-wrapped: 2; already on the new KEK: 0; shredded \(left as is\): 1/);
    const out = lines.join("\n");
    for (const secret of [oldKek, next, Buffer.from(oldKek, "base64").toString("hex"), Buffer.from(next, "base64").toString("hex")]) expect(out).not.toContain(secret);
    for (const row of before) if (row.wrappedDek) expect(out).not.toContain(row.wrappedDek);

    restartWith(next);
    expect(await openPii(s.a, s.sealedA)).toMatchObject({ name: "Test Person A" });
  });

  it("refuses missing keys and unknown arguments", async () => {
    await expect(rotateKek([], { USER_KEK: newKek() })).rejects.toThrow(/USER_KEK_PREVIOUS/);
    await expect(rotateKek(["--force"], { USER_KEK: newKek(), USER_KEK_PREVIOUS: newKek() })).rejects.toThrow(/unknown argument/);
    await expect(rotateKek([], { USER_KEK: "c2hvcnQ=", USER_KEK_PREVIOUS: newKek() })).rejects.toThrow(/32 bytes/);
  });
});
