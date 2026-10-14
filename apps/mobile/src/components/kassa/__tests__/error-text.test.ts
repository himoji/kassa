import { describe, expect, it } from "@jest/globals";

import { KassaApiError } from "@/api/errors";
import type { TFn } from "@/lib/i18n";

import { errorText } from "../error-text";

const t = ((key: string) => key) as unknown as TFn;
const problem = (detail: string) => ({
  type: "/problems/NOT_FOUND",
  title: "Not Found",
  status: 404,
  detail,
  error: detail,
  code: "NOT_FOUND",
});

describe("errorText", () => {
  it("says the server is out of date when it has no such route", () => {
    const err = new KassaApiError(404, problem("No route GET /api/insights/spending"));
    expect(err.missingRoute).toBe(true);
    expect(errorText(t, err)).toBe("common:errors.serverOutdated");
  });

  it("keeps a missing record a plain not-found", () => {
    const err = new KassaApiError(404, problem("transaction not found"));
    expect(err.missingRoute).toBe(false);
    expect(errorText(t, err)).not.toBe("common:errors.serverOutdated");
  });
});
