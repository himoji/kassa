import type { z } from "zod";

/** Non-Wise routes answer errors in the shared ApiError shape `{ error, code, details? }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown, what = "body"): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `Invalid ${what}`,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}
