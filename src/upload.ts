import type { Env } from "./env";
import { FORMATS, ID, imageExists, MiB, randomId, sniffImage } from "./images";
import { LIMITS } from "./schemas";

export const UPLOAD_TTL_SECONDS = 15 * 60;
const encoder = new TextEncoder();

/**
 * HMAC key for upload URLs, derived with HKDF from UPLOAD_SIGNING_KEY or, when that optional
 * secret is not set, from OPENAI_API_KEY, so uploads work without an extra deployment step.
 */
async function signingKey(env: Env): Promise<CryptoKey> {
  const secret = env.UPLOAD_SIGNING_KEY || env.OPENAI_API_KEY;
  if (!secret) throw new Error("Uploads need UPLOAD_SIGNING_KEY or OPENAI_API_KEY to be set");
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("openai-image-mcp"), info: encoder.encode("upload-url-signature-v1") },
    base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"],
  );
}

const toBase64Url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Only the canonical encoding is accepted, so every change to the signature is rejected.
  return toBase64Url(bytes.buffer) === value ? bytes : null;
}

export async function signUpload(env: Env, id: string, exp: number): Promise<string> {
  return toBase64Url(await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(`${id}.${exp}`)));
}

export async function createUploads(env: Env, origin: string, count: number) {
  const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
  const uploads = [];
  for (let i = 0; i < count; i++) {
    const id = randomId();
    const upload_url = `${origin}/upload/${id}?exp=${exp}&sig=${await signUpload(env, id, exp)}`;
    uploads.push({ id, upload_url, curl: `curl -sS --fail-with-body -X PUT --data-binary @/path/to/image.png '${upload_url}'` });
  }
  return {
    uploads,
    method: "PUT" as const,
    expires_at: new Date(exp * 1000).toISOString(),
    max_bytes: LIMITS.imageBytes,
    next: `Replace /path/to/image.png with the local file (PNG, JPEG or WebP) and run the curl command${count > 1 ? "s, one file per URL" : ""}. Then call edit with images: [${uploads.map((upload) => `"${upload.id}"`).join(", ")}] (or use an id as mask/markup).`,
  };
}

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** PUT /upload/<id>?exp=&sig= : stores one PNG, JPEG or WebP as img/<id>.<ext>. */
export async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "PUT") return new Response("Use PUT with the URL returned by create_upload", { status: 405, headers: { Allow: "PUT" } });
  const url = new URL(request.url);
  const id = url.pathname.slice("/upload/".length);
  const exp = Number(url.searchParams.get("exp"));
  const signature = fromBase64Url(url.searchParams.get("sig") ?? "");
  if (!ID.test(id) || !Number.isSafeInteger(exp) || !signature ||
      !await crypto.subtle.verify("HMAC", await signingKey(env), signature, encoder.encode(`${id}.${exp}`))) {
    return reply(403, { error: "Invalid upload URL signature; call create_upload for a new URL and use it unchanged" });
  }
  if (Date.now() / 1000 > exp) return reply(410, { error: "Upload URL expired; call create_upload for a new one" });
  const tooLarge = { error: `File exceeds the ${LIMITS.imageBytes / MiB} MiB upload limit` };
  if (Number(request.headers.get("content-length") ?? 0) > LIMITS.imageBytes) return reply(413, tooLarge);
  if (await imageExists(env.IMAGES_BUCKET, id)) return reply(409, { error: "This upload URL was already used; call create_upload for a new one" });
  if (!request.body) return reply(400, { error: "Empty body; send the file with curl --data-binary @FILE" });

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.imageBytes) {
      await reader.cancel();
      return reply(413, tooLarge);
    }
    chunks.push(value);
  }
  if (!total) return reply(400, { error: "Empty body; send the file with curl --data-binary @FILE" });
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const info = sniffImage(bytes);
  if (!info) return reply(415, { error: "Not a PNG, JPEG or WebP file (checked from the file contents)" });

  const created = new Date().toISOString();
  const size = info.width && info.height ? `${info.width}x${info.height}` : "unknown";
  const image = {
    id, url: `${url.origin}/img/${id}`, width: info.width, height: info.height,
    format: info.format, content_type: FORMATS[info.format], bytes: total,
  };
  await env.IMAGES_BUCKET.put(`img/${id}.${info.format}`, bytes, {
    httpMetadata: { contentType: FORMATS[info.format] },
    customMetadata: { source: "upload", size, "created-at": created },
  });
  await env.IMAGES_BUCKET.put(`meta/${id}.json`, JSON.stringify({ ...image, source: "upload", created_at: created }, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  return reply(201, { ...image, next: `Pass "${id}" in edit's images, mask or markup.` });
}
