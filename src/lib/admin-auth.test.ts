/**
 * Phase 7 task 7.1 — the guard fails closed. specs/02 §2.1 (defect #8).
 *
 * The container-level boot refusal (specs/02 AC3) is gated by `docker run` in
 * the plan; this covers the request-time half, including the unset case that
 * the fail-open shape would silently admit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { requireAdmin } from "./admin-auth";

const original = process.env.ADMIN_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = original;
});

const request = (key?: string) =>
  new Request("http://localhost/api/products", {
    headers: key === undefined ? {} : { "x-admin-key": key },
  });

describe("requireAdmin", () => {
  it("rejects when ADMIN_API_KEY is unset — even with no header sent", () => {
    delete process.env.ADMIN_API_KEY;
    // The fail-open shape — `if (configured && header !== configured)` — would
    // return null here and admit everyone. That is the defect.
    expect(requireAdmin(request())?.status).toBe(401);
    expect(requireAdmin(request("anything"))?.status).toBe(401);
  });

  it("rejects when ADMIN_API_KEY is empty", () => {
    process.env.ADMIN_API_KEY = "";
    expect(requireAdmin(request(""))?.status).toBe(401);
  });

  it("rejects the placeholder value", () => {
    process.env.ADMIN_API_KEY = "change-me";
    expect(requireAdmin(request("change-me"))?.status).toBe(401);
  });

  it("rejects a missing or wrong header when configured", () => {
    process.env.ADMIN_API_KEY = "real-key";
    expect(requireAdmin(request())?.status).toBe(401);
    expect(requireAdmin(request("wrong"))?.status).toBe(401);
  });

  it("admits the correct key", () => {
    process.env.ADMIN_API_KEY = "real-key";
    expect(requireAdmin(request("real-key"))).toBeNull();
  });
});
