/*
 * Output contract: every command prints exactly ONE JSON object on stdout. Success → exit 0.
 * Failure → `{ "error": CODE, ... }` and exit 1. Diagnostics go to stderr only.
 */

export class SimError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new SimError(code, message, extra);
}

export function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printError(err: unknown): void {
  if (err instanceof SimError) {
    print({ error: err.code, message: err.message, ...err.extra });
    return;
  }
  const e = err as Error;
  print({ error: "SIM_INTERNAL", message: e?.message ?? String(err) });
}

/** Parse `'<json>'` or `@file` arguments. */
export async function jsonArg(raw: string | undefined, what: string): Promise<unknown> {
  if (raw === undefined) fail("BAD_ARGS", `missing ${what} (JSON or @file)`);
  let text = raw;
  if (raw.startsWith("@")) {
    const f = Bun.file(raw.slice(1));
    if (!(await f.exists())) fail("BAD_ARGS", `${what}: file not found ${raw.slice(1)}`);
    text = await f.text();
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail("BAD_ARGS", `${what} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Plain text or @file. */
export async function textArg(raw: string | undefined, what: string): Promise<string> {
  if (raw === undefined) fail("BAD_ARGS", `missing ${what}`);
  if (raw.startsWith("@")) {
    const f = Bun.file(raw.slice(1));
    if (!(await f.exists())) fail("BAD_ARGS", `${what}: file not found ${raw.slice(1)}`);
    return f.text();
  }
  return raw;
}
