import { vi } from "vitest";
import type { Env } from "../src/env";
import { ImageJob } from "../src/jobs";

export const ORIGIN = "https://images.example";
export const OPENAI = "https://api.openai.com/v1/images/";

/** A PNG header with the given size; `padding` adds varied bytes so base64 contains "+" and "/". */
export function png(width: number, height: number, padding = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  for (let i = 33; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
  return bytes;
}

export function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
    0xff, 0xd9,
  ]);
}

export function webp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30);
  bytes.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  bytes.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
  bytes.set([...kind].map((c) => c.charCodeAt(0)), 12);
  if (kind === "VP8 ") {
    bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8], 20);
  } else if (kind === "VP8L") {
    const bits = (width - 1) | ((height - 1) << 14);
    bytes.set([0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 20);
  } else {
    bytes.set([0, 0, 0, 0, (width - 1) & 255, ((width - 1) >> 8) & 255, (width - 1) >> 16, (height - 1) & 255, ((height - 1) >> 8) & 255, (height - 1) >> 16], 20);
  }
  return bytes;
}

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export interface StoredObject { bytes: Uint8Array; options: R2PutOptions; size?: number }

function r2Body(object: StoredObject) {
  return {
    size: object.size ?? object.bytes.byteLength,
    arrayBuffer: async () => object.bytes.slice().buffer,
    body: new Blob([object.bytes as Uint8Array<ArrayBuffer>]).stream(),
    httpMetadata: object.options.httpMetadata,
    customMetadata: object.options.customMetadata,
    httpEtag: '"test-etag"',
  };
}

/** In-memory R2, Images, KV and job Durable Objects. */
export function fixture({ images = true } = {}) {
  const objects = new Map<string, StoredObject>();
  const bucket = {
    put: vi.fn(async (key: string, value: Uint8Array | string, options: R2PutOptions = {}) => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
      objects.set(key, { bytes, options });
    }),
    get: vi.fn(async (key: string) => (objects.has(key) ? r2Body(objects.get(key)!) : null)),
    head: vi.fn(async (key: string) => (objects.has(key) ? { size: objects.get(key)!.bytes.byteLength } : null)),
  };
  const transform = vi.fn().mockReturnThis();
  const output = vi.fn(async () => ({ response: () => new Response("small-jpeg") }));
  const input = vi.fn(() => ({ transform, output }));
  const kvData = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string, options?: string | { type: string }) => {
      const value = kvData.get(key);
      const type = typeof options === "string" ? options : options?.type;
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => { kvData.set(key, value); }),
    delete: vi.fn(async (key: string) => { kvData.delete(key); }),
  };
  const jobs = new Map<string, { job: ImageJob; data: Map<string, unknown>; alarm: { at: number | null } }>();
  const env = {
    IMAGES_BUCKET: bucket,
    ...(images ? { IMAGES: { input } } : {}),
    OPENAI_API_KEY: "test-placeholder-not-a-real-key",
    AUTH_PASSWORD: "test-placeholder-password",
    OAUTH_KV: kv,
    IMAGE_JOBS: {
      getByName(name: string) {
        if (!jobs.has(name)) {
          const data = new Map<string, unknown>();
          const alarm = { at: null as number | null };
          let timer: ReturnType<typeof setTimeout> | undefined;
          const storage = {
            get: async (key: string) => structuredClone(data.get(key)),
            put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
            deleteAll: async () => { data.clear(); alarm.at = null; },
            setAlarm: async (time: number) => {
              alarm.at = time;
              clearTimeout(timer);
              // Only near-term alarms run in tests; the 30-day retention alarm is just recorded.
              if (time - Date.now() < 60_000) timer = setTimeout(() => void job.alarm(), Math.max(0, time - Date.now()));
            },
          };
          const job: ImageJob = new ImageJob({ storage } as unknown as DurableObjectState, env);
          jobs.set(name, { job, data, alarm });
        }
        return jobs.get(name)!.job;
      },
    },
  } as unknown as Env;
  return { env, bucket, objects, jobs, input, transform, output };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A response body delivered in small chunks, to exercise streaming parsers. */
export function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

export function imagesResponse(list: Uint8Array[], extra: Record<string, unknown> = {}) {
  return {
    created: 1767225600,
    data: list.map((bytes) => ({ b64_json: b64(bytes) })),
    usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70, input_tokens_details: { image_tokens: 0, text_tokens: 50 } },
    size: "1024x1024", quality: "high", background: "opaque", output_format: "png",
    ...extra,
  };
}

/** Routes fetch: OpenAI image endpoints go to `openai`, other URLs to `downloads`. */
export function mockFetch(
  openai: (endpoint: string, init: RequestInit) => Response | Promise<Response>,
  downloads: Record<string, () => Response> = {},
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith(OPENAI)) return openai(url.slice(OPENAI.length), init ?? {});
    const download = downloads[url];
    if (download) return download();
    return new Response("Not found", { status: 404 });
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
