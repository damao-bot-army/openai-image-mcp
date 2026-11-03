import { afterEach, describe, expect, it, vi } from "vitest";

// Unit tests isolate the Durable Object transport; scripts/smoke.mjs tests the real one.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() { return { fetch: async () => new Response("MCP transport") }; }
  },
}));

import worker, { publicHandler, runTool, type Env } from "../src/index";

const DEFAULT_MODEL = "gpt-image-2.5-sunburst";

const SOURCE = btoa("full-size-image-bytes");
const PREVIEW = btoa("small-jpeg");
const IMAGE_ID = "aB0123456789cDeF012345";
function fixture(withImages = true) {
  const objects = new Map<string, { bytes: ArrayBuffer; options: R2PutOptions }>();
  const bucket = {
    put: vi.fn(async (key: string, bytes: Uint8Array, options: R2PutOptions) => {
      objects.set(key, { bytes: bytes.slice().buffer, options });
    }),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? {
        arrayBuffer: async () => object.bytes,
        body: new Blob([object.bytes]).stream(),
        httpMetadata: object.options.httpMetadata,
        httpEtag: '"test-etag"',
      } : null;
    }),
  };
  const transform = vi.fn().mockReturnThis();
  const output = vi.fn(async () => ({ response: () => new Response(atob(PREVIEW)) }));
  const input = vi.fn(() => ({ transform, output }));
  const kvData = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const value = kvData.get(key);
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => { kvData.set(key, value); }),
    delete: vi.fn(async (key: string) => { kvData.delete(key); }),
  };
  const env = {
    IMAGES_BUCKET: bucket,
    ...(withImages ? { IMAGES: { input } } : {}),
    OPENAI_API_KEY: "test-placeholder-not-a-real-key",
    AUTH_PASSWORD: "test-placeholder-password",
    OAUTH_KV: kv,
  } as unknown as Env;
  return { env, bucket, objects, input, transform, output };
}
function mockOpenAI(extra = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ b64_json: SOURCE }], usage: { total_tokens: 42 }, ...extra }));
}
function message(result: Awaited<ReturnType<typeof runTool>>) {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
}
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
afterEach(() => vi.restoreAllMocks());

describe("input validation", () => {
  it.each([
    ["generate", {}, "prompt"],
    ["generate", { prompt: " " }, "prompt"],
    ["generate", { prompt: "x".repeat(1501) }, "1500 UTF-8 bytes"],
    ["generate", { prompt: "a", n: 5 }, "n"],
    ["generate", { prompt: "a", size: "wrong" }, "size"],
    ["generate", { prompt: "a", quality: "wrong" }, "quality"],
    ["generate", { prompt: "a", output_format: "gif" }, "output_format"],
    ["generate", { prompt: "a", background: "wrong" }, "background"],
    ["generate", { prompt: "a", background: "transparent", output_format: "jpeg" }, "png or webp"],
    ["edit", { prompt: "a", images: [] }, "images"],
    ["edit", { prompt: "a", images: ["http://example.com/a.png"] }, "images.0"],
    ["edit", { prompt: "a", images: [IMAGE_ID], mask: "bad-id" }, "mask"],
    ["edit", { prompt: "a", images: [IMAGE_ID], n: 2 }, "n"],
  ] as const)("rejects %s %j", async (name, raw, field) => {
    const fetch = mockOpenAI();
    const result = await runTool(name, raw, fixture().env, "https://images.example");
    expect(result.isError).toBe(true);
    expect(message(result)).toContain(field);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("image tools", () => {
  it("stores the full image and returns only a preview, URL, usage and model", async () => {
    const f = fixture();
    const fetch = mockOpenAI({ model: "response-model" });
    const result = await runTool("generate", { prompt: "A red fox", n: 1 }, f.env, "https://images.example");
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(message(result));
    const image = summary.images[0];
    expect(image.id).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(image.url).toBe(`https://images.example/img/${image.id}`);
    expect(summary.usage).toEqual({ total_tokens: 42 });
    expect(summary.model).toBe("response-model");
    expect(result.structuredContent).toEqual(summary);
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: PREVIEW });
    expect(JSON.stringify(result)).not.toContain(SOURCE);
    const saved = f.objects.get(`img/${image.id}.png`)!;
    expect(new TextDecoder().decode(saved.bytes)).toBe(atob(SOURCE));
    expect(saved.options.httpMetadata).toEqual({ contentType: "image/png" });
    expect(saved.options.customMetadata).toMatchObject({ prompt: "A red fox", model: "response-model", size: "auto" });
    expect(saved.options.customMetadata?.["created-at"]).toMatch(/^\d{4}-/);
    expect(f.transform).toHaveBeenCalledWith({ width: 512, height: 512, fit: "scale-down" });
    expect(f.output).toHaveBeenCalledWith({ format: "image/jpeg", quality: 75 });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe(DEFAULT_MODEL);
  });

  it.each(["jpeg", "webp"])("stores %s with correct extension and metadata", async (format) => {
    const f = fixture();
    mockOpenAI();
    await runTool("generate", { prompt: "A fox", output_format: format }, f.env, "https://images.example");
    const [key, value] = [...f.objects.entries()][0];
    expect(key).toMatch(new RegExp(`^img/[A-Za-z0-9]{22}\\.${format}$`));
    expect(value.options.httpMetadata).toEqual({ contentType: `image/${format}` });
  });

  it("generates unique IDs for multiple images and respects IMAGE_MODEL", async () => {
    const f = fixture(false);
    f.env.IMAGE_MODEL = "custom-image-model";
    const fetch = mockOpenAI({ data: Array.from({ length: 4 }, () => ({ b64_json: SOURCE })) });
    const result = await runTool("generate", { prompt: "Four foxes", n: 4 }, f.env, "https://images.example");
    const summary = JSON.parse(message(result));
    expect(new Set(summary.images.map((image: { id: string }) => image.id)).size).toBe(4);
    expect(summary.model).toBe("custom-image-model");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).n).toBe(4);
  });

  it("edits using an R2 ID, https URL and R2 mask", async () => {
    const f = fixture();
    await f.bucket.put(`img/${IMAGE_ID}.png`, new TextEncoder().encode("original"), { httpMetadata: { contentType: "image/png" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).startsWith("https://input.example/")) return new Response("downloaded", { headers: { "content-type": "image/jpeg" } });
      return Response.json({ data: [{ b64_json: SOURCE }] });
    });
    const result = await runTool("edit", { prompt: "Make it blue", images: [IMAGE_ID, "https://input.example/source.jpg"], mask: IMAGE_ID }, f.env, "https://images.example");
    expect(result.isError).toBeUndefined();
    expect(f.bucket.get).toHaveBeenCalledWith(`img/${IMAGE_ID}.png`);
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith("/edits"))!;
    const form = call[1]!.body as FormData;
    const files = form.getAll("image[]") as File[];
    expect(await files[0].text()).toBe("original");
    expect(await files[1].text()).toBe("downloaded");
    expect(files[1].type).toBe("image/jpeg");
    expect(await (form.get("mask") as File).text()).toBe("original");
    expect(form.get("model")).toBe(DEFAULT_MODEL);
    expect((call[1]!.headers as Headers).has("Content-Type")).toBe(false);
  });

  it.each([IMAGE_ID, "https://input.example/missing.png"])("names unresolvable input %s", async (image) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Missing", { status: 404 }));
    const result = await runTool("edit", { prompt: "Edit", images: [image] }, fixture().env, "https://images.example");
    expect(result.isError).toBe(true);
    expect(message(result)).toContain(image);
    expect(message(result)).toMatch(/previous result|publicly downloadable/);
  });

  it("names an unresolved mask URL", async () => {
    const f = fixture();
    await f.bucket.put(`img/${IMAGE_ID}.png`, new TextEncoder().encode("original"), { httpMetadata: { contentType: "image/png" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Missing", { status: 404 }));
    const result = await runTool("edit", { prompt: "Edit", images: [IMAGE_ID], mask: "https://input.example/missing-mask.png" }, f.env, "https://images.example");
    expect(result.isError).toBe(true);
    expect(message(result)).toContain("https://input.example/missing-mask.png");
    expect(message(result)).toContain("HTTP 404");
  });

  it("rejects redirects to private or non-https targets and names the source", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { Location: "http://localhost/private" } }));
    const result = await runTool("edit", { prompt: "Edit", images: ["https://input.example/source.png"] }, fixture().env, "https://images.example");
    expect(message(result)).toContain("https://input.example/source.png");
    expect(message(result)).toContain("public https");
  });

  it("propagates the OpenAI error code, parameter and message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { code: "invalid_api_key", message: "Incorrect API key provided", param: "model" } }, { status: 401 }));
    const result = await runTool("generate", { prompt: "A fox" }, fixture().env, "https://images.example");
    expect(result.isError).toBe(true);
    expect(message(result)).toContain("OpenAI HTTP 401 [invalid_api_key] (model): Incorrect API key provided");
  });

  it("succeeds without the Images binding and does not include base64", async () => {
    mockOpenAI();
    const result = await runTool("generate", { prompt: "A fox" }, fixture(false).env, "https://images.example");
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(message(result)).images[0].preview).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SOURCE);
  });

  it("preserves the stored image when preview transformation fails", async () => {
    mockOpenAI();
    const f = fixture();
    f.output.mockRejectedValue(new Error("Images unavailable"));
    const result = await runTool("generate", { prompt: "A fox" }, f.env, "https://images.example");
    expect(result.isError).toBeUndefined();
    expect(f.objects.size).toBe(1);
    expect(JSON.parse(message(result)).warnings[0]).toContain("Preview unavailable");
  });
});

describe("public image endpoint", () => {
  it("serves R2 bytes with correct content-type without authentication", async () => {
    const f = fixture();
    await f.bucket.put(`img/${IMAGE_ID}.webp`, new TextEncoder().encode("webp-bytes"), { httpMetadata: { contentType: "image/webp" } });
    const response = await worker.fetch(new Request(`https://images.example/img/${IMAGE_ID}`), f.env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(await response.text()).toBe("webp-bytes");
  });
  it.each([IMAGE_ID, "invalid", "../secret"])("returns 404 for unknown or invalid ID %s", async (id) => {
    const response = await publicHandler(new Request(`https://images.example/img/${id}`), fixture().env);
    expect(response.status).toBe(404);
  });
});

describe("OAuth", () => {
  it("rejects /mcp without a bearer token using the real OAuthProvider", async () => {
    const response = await worker.fetch(new Request("https://images.example/mcp", { method: "POST" }), fixture().env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
  });
  it("rejects an invalid bearer token", async () => {
    const response = await worker.fetch(new Request("https://images.example/mcp", { headers: { Authorization: "Bearer invalid-token" } }), fixture().env, ctx);
    expect(response.status).toBe(401);
  });
  it("rejects a wrong password before approving or issuing any authorization", async () => {
    const f = fixture();
    const approveConsent = vi.fn();
    f.env.OAUTH_PROVIDER = { approveConsent } as unknown as Env["OAUTH_PROVIDER"];
    const response = await publicHandler(new Request("https://images.example/authorize", {
      method: "POST", headers: { Origin: "https://images.example" },
      body: new URLSearchParams({ password: "wrong", decision: "approve", handle: "test-handle" }),
    }), f.env);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Incorrect authorization password");
    expect(approveConsent).not.toHaveBeenCalled();
  });
  it("rejects cross-origin authorization form submissions", async () => {
    const response = await publicHandler(new Request("https://images.example/authorize", {
      method: "POST", headers: { Origin: "https://evil.example" },
      body: new URLSearchParams({ password: "test-placeholder-password", decision: "approve" }),
    }), fixture().env);
    expect(response.status).toBe(403);
  });
});
