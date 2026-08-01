/**
 * Image storage and validation. specs/02 §8.
 *
 * No S3, no CDN — files live on the same /data volume as the SQLite database so
 * one `-v cartdata:/data` persists both.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The single source of truth for MIME <-> extension, used in BOTH directions:
 * deriving the stored extension at upload time, and setting Content-Type when
 * serving. One table, so the two can never disagree.
 */
export const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Stored names are flat and server-generated: `<id>.<ext>`, nothing else. */
export const STORED_NAME = /^[a-z0-9-]+\.(png|jpe?g|webp|gif)$/;

export function uploadDir(): string {
  return path.resolve(process.env.UPLOAD_DIR || "/data/uploads");
}

export function maxUploadBytes(): number {
  const raw = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_242_880;
}

export type StoreResult =
  | { ok: true; url: string; filename: string }
  | { ok: false; code: "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE"; message: string };

/**
 * Validates and stores one uploaded image. Shared by POST /api/uploads and the
 * multipart branch of POST /api/products, so the two paths cannot validate
 * differently.
 */
export async function storeUpload(file: File): Promise<StoreResult> {
  // Extension comes from the validated MIME type, never the client's filename.
  const extension = EXTENSION_BY_MIME[file.type];
  if (!extension) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: `Unsupported image type "${file.type || "unknown"}". Allowed: PNG, JPEG, WebP, GIF.`,
    };
  }

  const limit = maxUploadBytes();
  if (file.size > limit) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: `Image exceeds the ${limit} byte limit.`,
    };
  }

  const filename = `${randomUUID()}.${extension}`;
  const directory = uploadDir();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), Buffer.from(await file.arrayBuffer()));

  return { ok: true, url: `/uploads/${filename}`, filename };
}
