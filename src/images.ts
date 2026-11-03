export const FORMATS = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
export type Format = keyof typeof FORMATS;
export const ID = /^[A-Za-z0-9]{22}$/;
export const MiB = 1024 * 1024;

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export function randomId(length = 22): string {
  let id = "";
  // Rejection sampling avoids modulo bias.
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && id.length < length) id += ALPHABET[byte % 62];
    }
  }
  return id;
}

export interface ImageInfo { format: Format; width: number | null; height: number | null }

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** Identifies PNG, JPEG and WebP from their file headers and reads the pixel dimensions. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return { format: "png", width: null, height: null };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { format: "jpeg", ...jpegSize(bytes) };
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { format: "webp", ...webpSize(bytes) };
  return null;
}

function jpegSize(b: Uint8Array): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    // SOF0-SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return { width: null, height: null };
}

function webpSize(b: Uint8Array): { width: number | null; height: number | null } {
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8 " && b.length >= 30) return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return { width: null, height: null };
}

export async function findImage(bucket: R2Bucket, id: string): Promise<R2ObjectBody | null> {
  if (!ID.test(id)) return null;
  for (const ext of Object.keys(FORMATS)) {
    const object = await bucket.get(`img/${id}.${ext}`);
    if (object) return object;
  }
  return null;
}

export async function imageExists(bucket: R2Bucket, id: string): Promise<boolean> {
  for (const ext of Object.keys(FORMATS)) {
    if (await bucket.head(`img/${id}.${ext}`)) return true;
  }
  return false;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Incremental base64 decoder, so large images never exist as one huge string. */
class Base64Decoder {
  // Base64 is ASCII, so the native UTF-8 decoder converts it exactly (and much faster than fromCharCode).
  private static ascii = new TextDecoder();
  private pending = "";
  private parts: Uint8Array[] = [];
  private size = 0;
  push(chunk: Uint8Array) {
    let text = this.pending + Base64Decoder.ascii.decode(chunk);
    // JSON may escape "/" as "\/"; base64 never contains a backslash.
    if (text.includes("\\")) text = text.replaceAll("\\", "");
    const usable = text.length - (text.length % 4);
    this.pending = text.slice(usable);
    if (usable) this.add(text.slice(0, usable));
  }
  private add(encoded: string) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    this.parts.push(bytes);
    this.size += bytes.length;
  }
  finish(): Uint8Array {
    if (this.pending) this.add(this.pending.padEnd(Math.ceil(this.pending.length / 4) * 4, "="));
    if (this.parts.length === 1) return this.parts[0];
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) { out.set(part, offset); offset += part.length; }
    return out;
  }
}

const B64_KEY = /"b64_json"\s*:\s*"$/;
/**
 * Streams a JSON or SSE body, decoding every "b64_json" string value as soon as it ends.
 * `onImage` receives the decoded bytes and returns a placeholder that replaces the value;
 * `onText` receives the remaining (small) text in order.
 */
export async function extractBase64Fields(
  body: ReadableStream<Uint8Array>,
  onImage: (bytes: Uint8Array) => Promise<string>,
  onText: (text: string) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let capture: Base64Decoder | null = null;
  const emit = async (text: string) => {
    if (!text) return;
    tail = (tail + text).slice(-64);
    await onText(text);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let pos = 0;
    while (pos < value.length) {
      const quote = value.indexOf(0x22, pos);
      const end = quote === -1 ? value.length : quote;
      if (capture) {
        capture.push(value.subarray(pos, end));
        if (quote === -1) break;
        const placeholder = await onImage(capture.finish());
        capture = null;
        await emit(`${placeholder}"`);
        pos = quote + 1;
      } else {
        await emit(decoder.decode(value.subarray(pos, quote === -1 ? end : quote + 1), { stream: true }));
        if (quote === -1) break;
        pos = quote + 1;
        // Escaped quotes inside other strings are preceded by "\", so they never match.
        if (B64_KEY.test(tail)) capture = new Base64Decoder();
      }
    }
  }
  await emit(decoder.decode());
  if (capture) throw new Error("the response ended in the middle of an image");
}
