/**
 * One error shape for every route. specs/01 §7.3, specs/02 §6.
 */
import { NextResponse } from "next/server";
import type { ZodError } from "zod";

export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

export function apiError(code: ErrorCode, message: string, details?: unknown) {
  return NextResponse.json({ error: { message, code, details } }, { status: STATUS[code] });
}

export function validationError(error: ZodError) {
  return apiError("VALIDATION", "Request validation failed", error.flatten());
}

/** Parses JSON without throwing on an empty or malformed body. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
