/**
 * Admin guard. specs/02 §2.
 *
 * A demo-grade shared secret, documented as such in the README.
 */
import { apiError } from "./api/errors";

const PLACEHOLDER = "change-me";

/**
 * Returns an error response when the caller is not an admin, or null when they
 * are.
 *
 * Note the shape deliberately avoided:
 *
 *     if (configured && header !== configured) return 401;   // FAILS OPEN
 *
 * That variant is a pattern people write for local-dev convenience, and when
 * ADMIN_API_KEY is unset it admits everyone, silently. Rejecting an unset or
 * placeholder key unconditionally is the whole point of this function.
 */
export function requireAdmin(request: Request) {
  const configured = process.env.ADMIN_API_KEY;

  if (!configured || configured === PLACEHOLDER) {
    return apiError("UNAUTHORIZED", "Admin API is not configured");
  }
  if (request.headers.get("x-admin-key") !== configured) {
    return apiError("UNAUTHORIZED", "Missing or invalid x-admin-key");
  }
  return null;
}
