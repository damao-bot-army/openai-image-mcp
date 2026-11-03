import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() { return { fetch: async () => new Response("MCP transport") }; }
  },
}));

import worker from "../src/index";
import { createUploadTool } from "../src/tools";
import { createUploads, signUpload, UPLOAD_TTL_SECONDS } from "../src/upload";
import { fixture, jpeg, ORIGIN, png, webp } from "./helpers";

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const MiB = 1024 * 1024;
const ID = "uP0123456789aBcDeF0123";
afterEach(() => vi.restoreAllMocks());

const put = (f: ReturnType<typeof fixture>, url: string, body: BodyInit | null, headers: HeadersInit = {}) =>
  worker.fetch(new Request(url, { method: "PUT", body, headers, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit), f.env, ctx);
async function signed(f: ReturnType<typeof fixture>, id = ID, exp = Math.floor(Date.now() / 1000) + 600) {
  return `${ORIGIN}/upload/${id}?exp=${exp}&sig=${await signUpload(f.env, id, exp)}`;
}

describe("create_upload", () => {
  it("returns signed one-time URLs with ready-to-run curl commands", async () => {
    const f = fixture();
    const result = await createUploadTool({ count: 2 }, f.env, ORIGIN);
    const out = result.structuredContent as Awaited<ReturnType<typeof createUploads>>;
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(out);
    expect(out.method).toBe("PUT");
    expect(out.max_bytes).toBe(50 * MiB);
    expect(Date.parse(out.expires_at) - Date.now()).toBeGreaterThan((UPLOAD_TTL_SECONDS - 5) * 1000);
    expect(Date.parse(out.expires_at) - Date.now()).toBeLessThanOrEqual(UPLOAD_TTL_SECONDS * 1000);
    expect(out.uploads).toHaveLength(2);
    for (const upload of out.uploads) {
      expect(upload.id).toMatch(/^[A-Za-z0-9]{22}$/);
      expect(upload.upload_url).toMatch(new RegExp(`^${ORIGIN}/upload/${upload.id}\\?exp=\\d+&sig=[A-Za-z0-9_-]{43}$`));
      expect(upload.curl).toBe(`curl -sS --fail-with-body -X PUT --data-binary @/path/to/image.png '${upload.upload_url}'`);
    }
    expect(out.next).toContain(`images: ["${out.uploads[0].id}", "${out.uploads[1].id}"]`);
  });
});

describe("PUT /upload/<id>", () => {
  it("stores a valid PNG as img/<id>.png and serves it from /img/<id>", async () => {
    const f = fixture();
    const { uploads: [upload] } = await createUploads(f.env, ORIGIN, 1);
    const bytes = png(1024, 768, 500);
    const response = await put(f, upload.upload_url, bytes, { "Content-Type": "application/x-www-form-urlencoded" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: upload.id, url: `${ORIGIN}/img/${upload.id}`, width: 1024, height: 768, format: "png",
      content_type: "image/png", bytes: bytes.byteLength, next: `Pass "${upload.id}" in edit's images, mask or markup.`,
    });
    const stored = f.objects.get(`img/${upload.id}.png`)!;
    expect(Buffer.from(stored.bytes)).toEqual(Buffer.from(bytes));
    expect(stored.options.httpMetadata).toEqual({ contentType: "image/png" });
    expect(stored.options.customMetadata).toMatchObject({ source: "upload", size: "1024x768" });
    expect(JSON.parse(new TextDecoder().decode(f.objects.get(`meta/${upload.id}.json`)!.bytes))).toMatchObject({ id: upload.id, source: "upload", width: 1024 });
    const served = await worker.fetch(new Request(`${ORIGIN}/img/${upload.id}`), f.env, ctx);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
  });

  it.each([
    ["jpeg", jpeg(640, 480), "image/jpeg"],
    ["webp", webp("VP8 ", 320, 240), "image/webp"],
  ])("detects %s from the file contents", async (format, bytes, type) => {
    const f = fixture();
    const response = await put(f, await signed(f), bytes, { "Content-Type": "image/png" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ format, content_type: type });
    expect(f.objects.has(`img/${ID}.${format}`)).toBe(true);
  });

  it("rejects an expired URL", async () => {
    const f = fixture();
    const response = await put(f, await signed(f, ID, Math.floor(Date.now() / 1000) - 1), png(16, 16));
    expect(response.status).toBe(410);
    expect((await response.json() as { error: string }).error).toContain("expired");
    expect(f.objects.size).toBe(0);
  });

  it.each([
    ["signature", (url: URL) => url.searchParams.set("sig", `${url.searchParams.get("sig")!.startsWith("A") ? "B" : "A"}${url.searchParams.get("sig")!.slice(1)}`)],
    ["non-canonical signature", (url: URL) => {
      const sig = url.searchParams.get("sig")!;
      // The last character carries two padding bits; flipping them keeps the same MAC bytes.
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      url.searchParams.set("sig", sig.slice(0, -1) + alphabet[alphabet.indexOf(sig.at(-1)!) ^ 1]);
    }],
    ["expiry", (url: URL) => url.searchParams.set("exp", String(Number(url.searchParams.get("exp")) + 3600))],
    ["id", (url: URL) => { url.pathname = "/upload/xX0123456789aBcDeF0123"; }],
    ["missing signature", (url: URL) => url.searchParams.delete("sig")],
    ["malformed id", (url: URL) => { url.pathname = "/upload/short-id"; }],
  ])("rejects a tampered %s", async (_name, tamper) => {
    const f = fixture();
    const url = new URL(await signed(f));
    tamper(url);
    const response = await put(f, url.href, png(16, 16));
    expect(response.status).toBe(403);
    expect(f.objects.size).toBe(0);
  });

  it("rejects URLs signed with a different key and prefers UPLOAD_SIGNING_KEY", async () => {
    const f = fixture();
    const derived = await signed(f);
    f.env.UPLOAD_SIGNING_KEY = "separate-upload-signing-key-for-tests";
    expect((await put(f, derived, png(16, 16))).status).toBe(403);
    const dedicated = await signed(f);
    expect(dedicated).not.toBe(derived);
    expect((await put(f, dedicated, png(16, 16))).status).toBe(201);
  });

  it("accepts each URL only once", async () => {
    const f = fixture();
    const url = await signed(f);
    expect((await put(f, url, png(16, 16))).status).toBe(201);
    const again = await put(f, url, jpeg(16, 16));
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toContain("already used");
    expect(f.objects.has(`img/${ID}.jpeg`)).toBe(false);
  });

  it.each([
    ["text", new TextEncoder().encode("just some text")],
    ["gif", new TextEncoder().encode("GIF89a\x10\x00\x10\x00")],
  ])("rejects %s content", async (_name, bytes) => {
    const f = fixture();
    const response = await put(f, await signed(f), bytes, { "Content-Type": "image/png" });
    expect(response.status).toBe(415);
    expect(f.objects.size).toBe(0);
  });

  it("rejects an empty body", async () => {
    const f = fixture();
    expect((await put(f, await signed(f), new Uint8Array())).status).toBe(400);
  });

  it("rejects a declared size over 50 MiB before reading the body", async () => {
    const f = fixture();
    const response = await worker.fetch(new Request(await signed(f), {
      method: "PUT", body: png(16, 16), headers: { "Content-Length": String(50 * MiB + 1) },
    }), f.env, ctx);
    expect(response.status).toBe(413);
  });

  it("rejects a streamed body that grows past 50 MiB", async () => {
    const f = fixture();
    let sent = 0;
    const chunk = new Uint8Array(MiB);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 52 * MiB) return controller.close();
        controller.enqueue(sent === 0 ? png(16, 16, MiB - 33) : chunk);
        sent += MiB;
      },
    });
    const response = await put(f, await signed(f), body);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThanOrEqual(52 * MiB);
    expect(f.objects.size).toBe(0);
  });

  it("allows only PUT", async () => {
    const f = fixture();
    const response = await worker.fetch(new Request(await signed(f)), f.env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("PUT");
  });
});
