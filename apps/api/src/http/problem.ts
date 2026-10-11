/*
 * RFC 9457 problem details. Every non-2xx response is `application/problem+json` with the RFC members
 * (type, title, status, detail, instance) plus extension members matching @kassa/shared `ApiError`
 * (error, code, reasonCodes, details), so clients can read either shape.
 */
import type { ReasonCode } from "@kassa/shared";

export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly reasonCodes: ReasonCode[] | undefined;
  readonly details: unknown;

  constructor(
    status: number,
    code: ReasonCode | string,
    detail?: string,
    extra: { reasonCodes?: ReasonCode[]; details?: unknown } = {},
  ) {
    super(detail ?? code);
    this.status = status;
    this.code = code;
    this.reasonCodes = extra.reasonCodes;
    this.details = extra.details;
  }
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  error: string;
  code?: string;
  reasonCodes?: ReasonCode[];
  details?: unknown;
};

export function problemBody(
  status: number,
  code: string | undefined,
  detail: string | undefined,
  instance: string | undefined,
  extra: { reasonCodes?: ReasonCode[]; details?: unknown } = {},
): ProblemBody {
  const title = TITLES[status] ?? "Error";
  return {
    // RFC 9457 §4.2: "about:blank" when no further semantics; we use a stable relative URI per code.
    type: code ? `/problems/${code}` : "about:blank",
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
    error: detail ?? title,
    ...(code ? { code } : {}),
    ...(extra.reasonCodes ? { reasonCodes: extra.reasonCodes } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
  };
}

export const notFound = (what: string) => new HttpProblem(404, "NOT_FOUND", `${what} not found`);
export const badRequest = (detail: string, code = "BAD_REQUEST") => new HttpProblem(400, code, detail);
export const conflict = (code: string, detail?: string, extra?: { reasonCodes?: ReasonCode[]; details?: unknown }) =>
  new HttpProblem(409, code, detail, extra);
