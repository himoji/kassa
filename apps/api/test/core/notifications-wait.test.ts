/*
 * GET /notifications/wait: the app's real-time feed (a long poll, since the API also runs as a Vercel Function).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { notify } from "../../src/modules/notifications/service.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";

const t = useTestDb();
const app = useTestApp();

type Wait = { cursor: string; changed: boolean; notifications: { id: string; kind: string }[]; unread: number };

describe("GET /notifications/wait", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  const wait = async (userId: string, query: string) => {
    const res = await app().inject({ method: "GET", url: `/api/notifications/wait?${query}`, headers: await bearer(userId) });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Wait;
  };

  it("answers at once without a cursor, holds while nothing changed, returns as soon as a notification lands", async () => {
    const { userId } = await createUserWithPasskey();
    const first = await wait(userId, "");
    expect(first).toMatchObject({ changed: true, notifications: [] });

    const started = Date.now();
    const idle = await wait(userId, `cursor=${encodeURIComponent(first.cursor)}&waitMs=1200`);
    expect(idle).toMatchObject({ changed: false, cursor: first.cursor });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100);

    const pending = wait(userId, `cursor=${encodeURIComponent(first.cursor)}&waitMs=10000`);
    setTimeout(() => void notify(userId, { kind: "MONEY_RECEIVED", title: "Aru sent you 5 000 KZT", body: "From another Kassa wallet." }), 300);
    const t0 = Date.now();
    const got = await pending;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(got.changed).toBe(true);
    expect(got.cursor).not.toBe(first.cursor);
    expect(got.notifications[0]).toMatchObject({ kind: "MONEY_RECEIVED" });
    expect(got.unread).toBe(1);
  });

  it("only sees the caller's own feed", async () => {
    const a = await createUserWithPasskey();
    const b = await createUserWithPasskey();
    const first = await wait(a.userId, "");
    await notify(b.userId, { kind: "MONEY_RECEIVED", title: "x", body: "y" });
    const idle = await wait(a.userId, `cursor=${encodeURIComponent(first.cursor)}&waitMs=1100`);
    expect(idle).toMatchObject({ changed: false, notifications: [] });
  });
});
