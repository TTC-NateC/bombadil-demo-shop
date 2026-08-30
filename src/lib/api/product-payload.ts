/**
 * Reads a product payload from either JSON or multipart/form-data. specs/02 §4.
 */
import { prisma } from "@/lib/db";
import { storeUpload, type StoreResult } from "@/lib/uploads";
import { slugify } from "./schemas";

export interface RawProductPayload {
  [key: string]: unknown;
}

export type PayloadResult =
  | { ok: true; payload: RawProductPayload }
  | { ok: false; code: "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE"; message: string };

function coerce(key: string, value: string): unknown {
  if (key === "priceCents") return Number(value);
  if (key === "active") return value === "true";
  if (key === "relatedIds") {
    try {
      return JSON.parse(value);
    } catch {
      return value.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return value;
}

export async function readProductPayload(request: Request): Promise<PayloadResult> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    const json = await request.json().catch(() => ({}));
    return { ok: true, payload: (json ?? {}) as RawProductPayload };
  }

  const form = await request.formData();
  const payload: RawProductPayload = {};

  for (const [key, value] of form.entries()) {
    if (key === "image") continue;
    if (typeof value === "string") payload[key] = coerce(key, value);
  }

  const image = form.get("image");
  if (image instanceof File && image.size > 0) {
    const stored: StoreResult = await storeUpload(image);
    if (!stored.ok) return stored;
    // An uploaded image wins over any imageUrl field (§4).
    payload.imageUrl = stored.url;
  }

  return { ok: true, payload };
}

/** Derives a free slug from a name, suffixing on collision. */
export async function uniqueSlug(name: string, preferred?: string): Promise<string> {
  const base = (preferred && slugify(preferred)) || slugify(name) || "product";

  let candidate = base;
  let suffix = 2;
  while (await prisma.product.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}
