/** @jest-environment node */
import { describe, expect, it } from "@jest/globals";

import { auth } from "@/lib/shims/auth";
import { serverAuth } from "@/lib/shims/server-auth";

describe("auth shims (auth/none)", () => {
  it("sends no credentials", async () => {
    await expect(auth.getAuthHeaders()).resolves.toEqual({});
  });

  it("proves nobody on the server, whatever the request claims", async () => {
    expect(serverAuth.provider).toBe("none");
    const request = new Request("https://api.test/x", {
      headers: { authorization: "Bearer forged", cookie: "session=forged" },
    });
    await expect(serverAuth.getRequestUser(request)).resolves.toBeNull();
  });
});
