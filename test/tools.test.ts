import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JOB_RETENTION_MS } from "../src/jobs";
import { getJobTool, imageTool, registerTools, timing, type ToolExtra } from "../src/tools";
import { handleUpload, signUpload } from "../src/upload";
import {
  b64, chunked, deferred, fixture, imagesResponse, jpeg, mockFetch, ORIGIN, png, sleep, webp,
} from "./helpers";

const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const IMAGE_ID = "aB0123456789cDeF012345";
const OTHER_ID = "zZ9876543210yYxX987654";
const MiB = 1024 * 1024;
// "A red fox running through the snow," in Chinese (13 characters).
const CJK = "\u4e00\u53ea\u5728\u96ea\u5730\u91cc\u5954\u8dd1\u7684\u7ea2\u72d0\u72f8\uff0c";
type Result = Awaited<ReturnType<typeof imageTool>>;
const text = (result: Result) => result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const summary = (result: Result) => result.structuredContent as any;
const jsonBody = (init: RequestInit) => JSON.parse(String(init.body));

afterEach(() => {
  vi.restoreAllMocks();
  timing.progressMs = 10_000;
});

/** Waits until the job has finished in the background, so no work leaks into the next test. */
async function settled(f: ReturnType<typeof fixture>, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const state = await f.env.IMAGE_JOBS.getByName(jobId) as unknown as { status(): Promise<{ status: string } | null> };
    const current = await state.status();
    if (current && (current.status === "succeeded" || current.status === "failed")) return current;
    await sleep(5);
  }
  throw new Error("job did not finish");
}

async function storeImage(f: ReturnType<typeof fixture>, id: string, bytes: Uint8Array, format = "png", size?: number) {
  await f.bucket.put(`img/${id}.${format}`, bytes, { httpMetadata: { contentType: `image/${format}` } });
  if (size !== undefined) f.objects.get(`img/${id}.${format}`)!.size = size;
}

describe("generate", () => {
  it("returns ids, urls, dimensions, format, bytes, usage, model and params directly when the job is fast", async () => {
    const f = fixture();
    const image = png(1536, 1024);
    const fetch = mockFetch(() => Response.json(imagesResponse([image], { size: "1536x1024", data: [{ b64_json: b64(image), revised_prompt: "A red fox, detailed" }] })));
    const result = await imageTool("generate", { prompt: "A red fox", size: "1536x1024", quality: "high" }, f.env, ORIGIN);
    expect(result.isError).toBeUndefined();
    const out = summary(result);
    expect(out.status).toBe("succeeded");
    expect(out.job_id).toMatch(/^job_[A-Za-z0-9]{22}$/);
    expect(out.images).toHaveLength(1);
    const [first] = out.images;
    expect(first).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9]{22}$/), url: `${ORIGIN}/img/${first.id}`,
      width: 1536, height: 1024, format: "png", bytes: image.byteLength, revised_prompt: "A red fox, detailed",
    });
    expect(out.model).toBe(DEFAULT_MODEL);
    expect(out.usage.total_tokens).toBe(70);
    expect(out.params).toEqual({ size: "1536x1024", quality: "high" });
    expect(out.resolved).toEqual({ size: "1536x1024", quality: "high", background: "opaque", output_format: "png" });
    expect(out.next).toContain(`edit with images: ["${first.id}"]`);
    expect(out.next).toContain(`curl -o ${first.id}.png ${first.url}`);
    expect(JSON.parse(text(result))).toEqual(out);
    expect(result.content).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(b64(image));
    expect(Buffer.from(f.objects.get(`img/${first.id}.png`)!.bytes)).toEqual(Buffer.from(image));
    const body = jsonBody(fetch.mock.calls[0][1]!);
    expect(body).toEqual({ model: DEFAULT_MODEL, prompt: "A red fox", size: "1536x1024", quality: "high" });
  });

  it("passes every model parameter through to OpenAI", async () => {
    const f = fixture();
    f.env.IMAGE_MODEL = "gpt-image-2.5-flare";
    const fetch = mockFetch(() => Response.json(imagesResponse(Array.from({ length: 10 }, () => png(3840, 2160)))));
    const result = await imageTool("generate", {
      prompt: "A city at night", size: "3840X2160", quality: "max", n: 10, background: "opaque",
      output_format: "webp", output_compression: 80, moderation: "low", safety_identifier: "user-hash", wait_seconds: 30,
    }, f.env, ORIGIN);
    expect(result.isError).toBeUndefined();
    const body = jsonBody(fetch.mock.calls[0][1]!);
    expect(body).toEqual({
      model: "gpt-image-2.5-flare", prompt: "A city at night", size: "3840x2160", quality: "max", n: 10, background: "opaque",
      output_format: "webp", output_compression: 80, moderation: "low", safety_identifier: "user-hash",
    });
    expect(fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/images/generations");
    const out = summary(result);
    expect(new Set(out.images.map((image: { id: string }) => image.id)).size).toBe(10);
    expect(out.params).toMatchObject({ quality: "max", n: 10, moderation: "low" });
  });

  it.each(["xhigh", "max", "low", "medium", "auto"])("accepts quality %s", async (quality) => {
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    const result = await imageTool("generate", { prompt: "A fox", quality }, fixture().env, ORIGIN);
    expect(result.isError).toBeUndefined();
    expect(jsonBody(fetch.mock.calls[0][1]!).quality).toBe(quality);
  });

  it("writes meta/<id>.json with the full prompt and keeps R2 custom metadata small", async () => {
    const f = fixture();
    // 8000 CJK characters, ~24 KB of UTF-8: far above the old 1500-byte limit and the 8 KiB R2 metadata limit.
    const prompt = CJK.repeat(700).slice(0, 8000);
    expect(new TextEncoder().encode(prompt).byteLength).toBeGreaterThan(20_000);
    const fetch = mockFetch(() => Response.json(imagesResponse([jpeg(1024, 1536)], { output_format: "jpeg", size: "1024x1536" })));
    const result = await imageTool("generate", { prompt, size: "1024x1536", output_format: "jpeg", output_compression: 90 }, f.env, ORIGIN);
    expect(result.isError).toBeUndefined();
    expect(jsonBody(fetch.mock.calls[0][1]!).prompt).toBe(prompt);
    const { id } = summary(result).images[0];
    const stored = f.objects.get(`img/${id}.jpeg`)!;
    expect(stored.options.httpMetadata).toEqual({ contentType: "image/jpeg" });
    const custom = stored.options.customMetadata!;
    expect(custom).toMatchObject({ source: "generate", model: DEFAULT_MODEL, size: "1024x1536", "job-id": summary(result).job_id });
    expect(custom["created-at"]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect([...custom["prompt-preview"]]).toHaveLength(200);
    expect(new TextEncoder().encode(JSON.stringify(custom)).byteLength).toBeLessThan(2048);
    const meta = JSON.parse(new TextDecoder().decode(f.objects.get(`meta/${id}.json`)!.bytes));
    expect(f.objects.get(`meta/${id}.json`)!.options.httpMetadata).toEqual({ contentType: "application/json" });
    expect(meta).toMatchObject({
      id, url: `${ORIGIN}/img/${id}`, job_id: summary(result).job_id, tool: "generate", index: 0, model: DEFAULT_MODEL, prompt,
      params: { size: "1024x1536", output_format: "jpeg", output_compression: 90 }, revised_prompt: null,
      usage: { total_tokens: 70 }, resolved: { size: "1024x1536", output_format: "jpeg" },
      image: { width: 1024, height: 1536, format: "jpeg", content_type: "image/jpeg", bytes: jpeg(1024, 1536).byteLength },
    });
    expect(meta.created_at).toMatch(/^\d{4}-/);
    expect(meta.warning).toBeNull();
    expect(summary(result).warning).toBeUndefined();
  });

  it("rejects a prompt over the token limit before calling OpenAI", async () => {
    const f = fixture();
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    const result = await imageTool("generate", { prompt: CJK.repeat(700).slice(0, 9000) }, f.env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("prompt: Prompt is too long: about 9,000 tokens (estimated)");
    expect(text(result)).toContain("OpenAI silently ignores prompts over about 8,192 tokens");
    expect(text(result)).toContain("roughly 8,000 Chinese, Japanese or Korean characters, or 32,000 characters of English");
    expect(fetch).not.toHaveBeenCalled();
    expect(f.jobs.size).toBe(0);
  });

  it("warns, without failing, when OpenAI reports that a long prompt was ignored", async () => {
    const f = fixture();
    const prompt = CJK.repeat(40);
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)], {
      usage: { input_tokens: 8, output_tokens: 4160, total_tokens: 4168, input_tokens_details: { image_tokens: 0, text_tokens: 8 } },
    })));
    const result = await imageTool("generate", { prompt }, f.env, ORIGIN);
    expect(result.isError).toBeUndefined();
    const out = summary(result);
    expect(out.status).toBe("succeeded");
    expect(out.warning).toBe(
      "OpenAI counted only 8 text input tokens for this 520-character prompt, so it most likely ignored the prompt and the image may not match it. " +
      "OpenAI drops prompts over about 8,192 tokens without an error; shorten the prompt and try again.",
    );
    const meta = JSON.parse(new TextDecoder().decode(f.objects.get(`meta/${out.images[0].id}.json`)!.bytes));
    expect(meta.warning).toBe(out.warning);
  });

  it.each([
    ["a short prompt with few tokens", "A red fox", { input_tokens: 8, input_tokens_details: { image_tokens: 0, text_tokens: 8 } }],
    ["a long prompt with normal usage", "A red fox in the snow. ".repeat(20), { input_tokens: 120, input_tokens_details: { image_tokens: 0, text_tokens: 120 } }],
    ["missing usage", "A red fox in the snow. ".repeat(20), undefined],
  ])("does not warn for %s", async (_name, prompt, usage) => {
    mockFetch(() => Response.json({ ...imagesResponse([png(1024, 1024)]), usage }));
    const result = await imageTool("generate", { prompt }, fixture().env, ORIGIN);
    expect(result.isError).toBeUndefined();
    expect(summary(result).warning).toBeUndefined();
  });

  it("accepts a 32000-character prompt and an ASCII prompt over 1500 bytes", async () => {
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    for (const prompt of ["x".repeat(32000), "a detailed scene ".repeat(100)]) {
      const result = await imageTool("generate", { prompt }, fixture().env, ORIGIN);
      expect(result.isError).toBeUndefined();
    }
  });

  it("stores images by their real format and decodes a response that arrives in small chunks", async () => {
    const f = fixture();
    const images = [webp("VP8X", 2048, 1152), jpeg(800, 600), png(1024, 1024, 5000)];
    mockFetch(() => new Response(chunked(JSON.stringify(imagesResponse(images)), 13), { headers: { "content-type": "application/json" } }));
    const result = await imageTool("generate", { prompt: "Three", n: 3 }, f.env, ORIGIN);
    const out = summary(result);
    expect(out.images.map((image: { format: string; width: number }) => [image.format, image.width])).toEqual([["webp", 2048], ["jpeg", 800], ["png", 1024]]);
    for (const [index, image] of out.images.entries()) {
      expect(Buffer.from(f.objects.get(`img/${image.id}.${image.format}`)!.bytes)).toEqual(Buffer.from(images[index]));
    }
  });

  it("returns 512px previews only when preview is true", async () => {
    const f = fixture();
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    const result = await imageTool("generate", { prompt: "A fox", preview: true }, f.env, ORIGIN);
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: btoa("small-jpeg") });
    expect(f.transform).toHaveBeenCalledWith({ width: 512, height: 512, fit: "scale-down" });
    expect(f.output).toHaveBeenCalledWith({ format: "image/jpeg", quality: 75 });
    const noBinding = fixture({ images: false });
    const without = await imageTool("generate", { prompt: "A fox", preview: true }, noBinding.env, ORIGIN);
    expect(without.isError).toBeUndefined();
    expect(without.content).toHaveLength(1);
    expect(summary(without).warning).toContain("Images binding");
  });

  it("uses OPENAI_BASE_URL when set", async () => {
    const f = fixture();
    f.env.OPENAI_BASE_URL = "https://gateway.example/v1/openai/";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(imagesResponse([png(1024, 1024)])));
    await imageTool("generate", { prompt: "A fox" }, f.env, ORIGIN);
    expect(fetch.mock.calls[0][0]).toBe("https://gateway.example/v1/openai/images/generations");
  });

  it("streams partial_images, stores them and returns them alongside the final image", async () => {
    const f = fixture();
    const partial = png(1024, 1024, 10);
    const final = png(1024, 1024, 20);
    const sse = [
      `event: image_generation.partial_image\ndata: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: b64(partial), partial_image_index: 0, size: "1024x1024" })}\n\n`,
      `event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: b64(final), size: "1024x1024", quality: "high", background: "opaque", output_format: "png", usage: { total_tokens: 99 } })}\n\n`,
    ].join("");
    const fetch = mockFetch(() => new Response(chunked(sse, 11), { headers: { "content-type": "text/event-stream" } }));
    const result = await imageTool("generate", { prompt: "A fox", partial_images: 1 }, f.env, ORIGIN);
    expect(jsonBody(fetch.mock.calls[0][1]!)).toMatchObject({ partial_images: 1, stream: true });
    const out = summary(result);
    expect(out.status).toBe("succeeded");
    expect(out.partial_images).toEqual([expect.objectContaining({ index: 0, width: 1024 })]);
    expect(out.images).toHaveLength(1);
    expect(out.usage).toEqual({ total_tokens: 99 });
    expect(out.params).toEqual({ partial_images: 1 });
    expect(Buffer.from(f.objects.get(`img/${out.images[0].id}.png`)!.bytes)).toEqual(Buffer.from(final));
    expect(f.objects.has(`img/${out.partial_images[0].id}.png`)).toBe(true);
    expect(f.objects.has(`meta/${out.images[0].id}.json`)).toBe(true);
    expect(f.objects.has(`meta/${out.partial_images[0].id}.json`)).toBe(false);
  });

  it("returns a streamed OpenAI error event verbatim", async () => {
    const sse = `event: error\ndata: ${JSON.stringify({ type: "error", error: { code: "moderation_blocked", message: "Your request was rejected by the safety system.", param: null } })}\n\n`;
    mockFetch(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const result = await imageTool("generate", { prompt: "A fox", partial_images: 2 }, fixture().env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("[moderation_blocked]: Your request was rejected by the safety system.");
  });

  it("returns the OpenAI HTTP error code, parameter and message verbatim", async () => {
    mockFetch(() => Response.json({ error: { code: "invalid_value", message: "Invalid size '3840x2160' for this model.", param: "size" } }, { status: 400 }));
    const result = await imageTool("generate", { prompt: "A fox", size: "3840x2160" }, fixture().env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("OpenAI HTTP 400 [invalid_value] (size): Invalid size '3840x2160' for this model.");
    expect(summary(result)).toMatchObject({ status: "failed", job_id: expect.stringMatching(/^job_/), error: expect.stringContaining("Invalid size") });
  });

  it("returns a non-JSON upstream error body", async () => {
    mockFetch(() => new Response("upstream connect error", { status: 502 }));
    const result = await imageTool("generate", { prompt: "A fox" }, fixture().env, ORIGIN);
    expect(text(result)).toContain("OpenAI HTTP 502: upstream connect error");
  });

  it("reports a missing OPENAI_API_KEY without starting a job", async () => {
    const f = fixture();
    f.env.OPENAI_API_KEY = "";
    const result = await imageTool("generate", { prompt: "A fox" }, f.env, ORIGIN);
    expect(text(result)).toContain("OPENAI_API_KEY");
    expect(f.jobs.size).toBe(0);
  });
});

describe("edit", () => {
  it("sends ids, URLs, markup and every edit parameter as multipart", async () => {
    const f = fixture();
    await storeImage(f, IMAGE_ID, png(1024, 1024));
    await storeImage(f, OTHER_ID, webp("VP8L", 1024, 1024), "webp");
    const markupId = "mK0123456789mK01234567";
    await storeImage(f, markupId, png(1024, 1024, 8));
    const downloaded = jpeg(640, 480);
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1024), png(1024, 1024)])), {
      // octet-stream on purpose: the format is read from the bytes.
      "https://input.example/photo": () => new Response(downloaded, { headers: { "content-type": "application/octet-stream" } }),
    });
    const result = await imageTool("edit", {
      prompt: "Blend them", images: [IMAGE_ID, "https://input.example/photo", `${ORIGIN}/img/${OTHER_ID}`], markup: markupId,
      n: 2, size: "2048x1152", quality: "xhigh", background: "auto", output_format: "jpeg", output_compression: 70,
      input_fidelity: "high", safety_identifier: "user-hash",
    }, f.env, ORIGIN);
    expect(result.isError).toBeUndefined();
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith("/images/edits"))!;
    const form = call[1]!.body as FormData;
    expect(Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"))).toEqual({
      model: DEFAULT_MODEL, prompt: "Blend them", n: "2", size: "2048x1152", quality: "xhigh", background: "auto",
      output_format: "jpeg", output_compression: "70", input_fidelity: "high", safety_identifier: "user-hash",
    });
    const files = form.getAll("image[]") as File[];
    expect(files.map((file) => [file.name, file.type])).toEqual([["image-1.png", "image/png"], ["image-2.jpeg", "image/jpeg"], ["image-3.webp", "image/webp"]]);
    expect(Buffer.from(await files[1].arrayBuffer())).toEqual(Buffer.from(downloaded));
    expect((form.get("markup") as File).name).toBe("markup.png");
    expect(form.get("mask")).toBeNull();
    expect((call[1]!.headers as Headers).has("Content-Type")).toBe(false);
    // Our own /img URL is read from R2, not fetched over HTTP.
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith(ORIGIN))).toBe(false);
    const out = summary(result);
    expect(out.images).toHaveLength(2);
    const meta = JSON.parse(new TextDecoder().decode(f.objects.get(`meta/${out.images[1].id}.json`)!.bytes));
    expect(meta).toMatchObject({ tool: "edit", index: 1, inputs: { images: [IMAGE_ID, "https://input.example/photo", `${ORIGIN}/img/${OTHER_ID}`], markup: markupId } });
    expect(f.objects.get(`img/${out.images[0].id}.png`)!.options.customMetadata!.source).toBe("edit");
  });

  it("warns from text_tokens when image tokens make input_tokens large", async () => {
    const f = fixture();
    await storeImage(f, IMAGE_ID, png(1024, 1024));
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)], {
      usage: { input_tokens: 1560, output_tokens: 4160, total_tokens: 5720, input_tokens_details: { image_tokens: 1552, text_tokens: 8 } },
    })));
    const result = await imageTool("edit", { prompt: "Make the fox blue and add falling snow. ".repeat(10), images: [IMAGE_ID] }, f.env, ORIGIN);
    expect(result.isError).toBeUndefined();
    expect(summary(result).warning).toContain("OpenAI counted only 8 text input tokens for this 400-character prompt");
  });

  it("edits an uploaded image by id, with an uploaded mask", async () => {
    const f = fixture();
    const upload = async (bytes: Uint8Array) => {
      const id = `up${String(Math.random()).slice(2, 12).padEnd(10, "0")}0123456789`;
      const exp = Math.floor(Date.now() / 1000) + 600;
      const response = await handleUpload(new Request(`${ORIGIN}/upload/${id}?exp=${exp}&sig=${await signUpload(f.env, id, exp)}`, { method: "PUT", body: bytes }), f.env);
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const source = png(1024, 1536, 300);
    const mask = png(1024, 1536, 40);
    const [sourceId, maskId] = [await upload(source), await upload(mask)];
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1536)])));
    const result = await imageTool("edit", { prompt: "Add a hat", images: [sourceId], mask: maskId }, f.env, ORIGIN);
    expect(result.isError).toBeUndefined();
    const form = fetch.mock.calls[0][1]!.body as FormData;
    expect(Buffer.from(await (form.getAll("image[]")[0] as File).arrayBuffer())).toEqual(Buffer.from(source));
    expect(Buffer.from(await (form.get("mask") as File).arrayBuffer())).toEqual(Buffer.from(mask));
  });

  it.each([
    ["mask", "jpeg", "mask must be a PNG image"],
    ["markup", "jpeg", "markup must be a PNG image"],
    ["mask", "big", "mask must be smaller than 4 MiB"],
  ])("checks the %s format (%s)", async (field, kind, message) => {
    const f = fixture();
    await storeImage(f, IMAGE_ID, png(1024, 1024));
    if (kind === "jpeg") await storeImage(f, OTHER_ID, jpeg(1024, 1024), "jpeg");
    else await storeImage(f, OTHER_ID, png(1024, 1024, 4 * MiB));
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    const result = await imageTool("edit", { prompt: "Edit", images: [IMAGE_ID], [field]: OTHER_ID }, f.env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects inputs that exceed 64 MiB in total before calling OpenAI", async () => {
    const f = fixture();
    await storeImage(f, IMAGE_ID, png(1024, 1024), "png", 40 * MiB);
    await storeImage(f, OTHER_ID, png(1024, 1024), "png", 30 * MiB);
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    const result = await imageTool("edit", { prompt: "Edit", images: [IMAGE_ID, OTHER_ID] }, f.env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Input images exceed the 64 MiB total for one edit (70.0 MiB including");
    expect(text(result)).toContain(OTHER_ID);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies the total limit to downloads using Content-Length", async () => {
    const f = fixture();
    await storeImage(f, IMAGE_ID, png(1024, 1024), "png", 45 * MiB);
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])), {
      "https://input.example/large.png": () => new Response(png(1024, 1024), { headers: { "content-length": String(20 * MiB) } }),
    });
    const result = await imageTool("edit", { prompt: "Edit", images: [IMAGE_ID, "https://input.example/large.png"] }, f.env, ORIGIN);
    expect(text(result)).toContain("64 MiB total");
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/images/edits"))).toBe(false);
  });

  it("rejects a single download over 50 MiB", async () => {
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])), {
      "https://input.example/huge.png": () => new Response(png(1024, 1024), { headers: { "content-length": String(51 * MiB) } }),
    });
    const result = await imageTool("edit", { prompt: "Edit", images: ["https://input.example/huge.png"] }, fixture().env, ORIGIN);
    expect(text(result)).toContain("each input must be under 50 MiB");
    expect(text(result)).toContain("https://input.example/huge.png");
  });

  it.each([
    [IMAGE_ID, "not found"],
    ["https://input.example/missing.png", "HTTP 404"],
  ])("names an unresolvable input %s", async (image, message) => {
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    const result = await imageTool("edit", { prompt: "Edit", images: [image] }, fixture().env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`Cannot use image "${image}"`);
    expect(text(result)).toContain(message);
  });

  it("rejects a download that is not an image", async () => {
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])), {
      "https://input.example/page": () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    });
    const result = await imageTool("edit", { prompt: "Edit", images: ["https://input.example/page"] }, fixture().env, ORIGIN);
    expect(text(result)).toContain("not a PNG, JPEG or WebP image (content-type text/html)");
  });

  it("rejects redirects to private or non-https targets", async () => {
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])), {
      "https://input.example/source.png": () => new Response(null, { status: 302, headers: { Location: "http://localhost/private" } }),
    });
    const result = await imageTool("edit", { prompt: "Edit", images: ["https://input.example/source.png"] }, fixture().env, ORIGIN);
    expect(text(result)).toContain("https://input.example/source.png");
    expect(text(result)).toContain("public https");
  });
});

describe("async jobs", () => {
  it("returns job_id for a slow job; get_job returns the result once it finishes", async () => {
    const f = fixture();
    const release = deferred();
    mockFetch(async () => {
      await release.promise;
      return Response.json(imagesResponse([png(3840, 2160)], { size: "3840x2160", quality: "max" }));
    });
    const started = await imageTool("generate", { prompt: "A 4K fox", size: "3840x2160", quality: "max", wait_seconds: 0.05 }, f.env, ORIGIN);
    expect(started.isError).toBeUndefined();
    const running = summary(started);
    expect(running).toMatchObject({ status: "running", job_id: expect.stringMatching(/^job_[A-Za-z0-9]{22}$/) });
    expect(running.next).toContain(`get_job with job_id "${running.job_id}"`);
    expect(JSON.parse(text(started))).toEqual(running);

    const stillRunning = await getJobTool({ job_id: running.job_id, wait_seconds: 0 }, f.env);
    expect(summary(stillRunning).status).toBe("running");

    const waiting = getJobTool({ job_id: running.job_id, wait_seconds: 5 }, f.env);
    await sleep(20);
    release.resolve();
    const done = await waiting;
    expect(done.isError).toBeUndefined();
    expect(summary(done)).toMatchObject({ status: "succeeded", job_id: running.job_id, images: [expect.objectContaining({ width: 3840, height: 2160 })] });
    // Results stay available.
    expect(summary(await getJobTool({ job_id: running.job_id, wait_seconds: 0 }, f.env)).images[0].id).toBe(summary(done).images[0].id);
    // Finished jobs are deleted after the retention period.
    expect(f.jobs.get(running.job_id)!.alarm.at).toBeGreaterThan(Date.now() + JOB_RETENTION_MS - 60_000);
  });

  it("keeps running after the caller disconnects and can be queried later", async () => {
    const f = fixture();
    const release = deferred();
    mockFetch(async () => {
      await release.promise;
      return Response.json(imagesResponse([png(1024, 1024)]));
    });
    const controller = new AbortController();
    const call = imageTool("generate", { prompt: "A fox", wait_seconds: 30 }, f.env, ORIGIN, { signal: controller.signal });
    await sleep(10);
    controller.abort();
    const jobId = summary(await call).job_id;
    release.resolve();
    expect((await settled(f, jobId)).status).toBe("succeeded");
    expect(summary(await getJobTool({ job_id: jobId }, f.env)).status).toBe("succeeded");
  });

  it("get_job returns the OpenAI error of a failed job", async () => {
    const f = fixture();
    const release = deferred();
    mockFetch(async () => {
      await release.promise;
      return Response.json({ error: { code: "rate_limit_exceeded", message: "Rate limit reached for images per minute.", param: null } }, { status: 429 });
    });
    const started = await imageTool("generate", { prompt: "A fox", wait_seconds: 0 }, f.env, ORIGIN);
    release.resolve();
    const result = await getJobTool({ job_id: summary(started).job_id, wait_seconds: 5 }, f.env);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("OpenAI HTTP 429 [rate_limit_exceeded]: Rate limit reached for images per minute.");
    expect(summary(result).status).toBe("failed");
  });

  it("reports unknown and malformed job ids", async () => {
    const unknown = await getJobTool({ job_id: `job_${IMAGE_ID}`, wait_seconds: 0 }, fixture().env);
    expect(text(unknown)).toContain("Unknown job_id");
    const malformed = await getJobTool({ job_id: IMAGE_ID }, fixture().env);
    expect(text(malformed)).toContain("job_id");
    expect(malformed.isError).toBe(true);
  });

  it("sends progress notifications while waiting and lists partial images", async () => {
    timing.progressMs = 15;
    const f = fixture();
    const release = deferred();
    const partial = png(1024, 1024, 12);
    const sse = (text: string) => new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: b64(partial), partial_image_index: 0 })}\n\n`));
        await release.promise;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    mockFetch(() => new Response(sse(`data: ${JSON.stringify({ type: "image_generation.completed", b64_json: b64(png(1024, 1024)), usage: { total_tokens: 5 } })}\n\n`), {
      headers: { "content-type": "text/event-stream" },
    }));
    const notifications: { progress: number; message?: string }[] = [];
    const extra: ToolExtra = {
      _meta: { progressToken: "token-1" },
      sendNotification: async (notification) => { notifications.push(notification.params); },
    };
    const first = await imageTool("generate", { prompt: "A fox", partial_images: 1, wait_seconds: 0.1 }, f.env, ORIGIN, extra);
    const out = summary(first);
    expect(out.status).toBe("running");
    expect(out.partial_images).toEqual([expect.objectContaining({ index: 0, width: 1024 })]);
    expect(notifications.length).toBeGreaterThanOrEqual(2);
    expect(notifications.every((n, i) => i === 0 || n.progress > notifications[i - 1].progress)).toBe(true);
    expect(notifications[0].message).toContain(out.job_id);
    expect(notifications.some((n) => n.message?.includes(`partial image 1: ${ORIGIN}/img/`))).toBe(true);
    release.resolve();
    const done = await getJobTool({ job_id: out.job_id }, f.env, extra);
    expect(summary(done)).toMatchObject({ status: "succeeded", partial_images: [expect.objectContaining({ index: 0 })] });
  });

  it("fails a job that was interrupted twice instead of retrying forever", async () => {
    const f = fixture();
    const fetch = mockFetch(() => Response.json(imagesResponse([png(1024, 1024)])));
    const release = deferred();
    fetch.mockImplementationOnce(async () => { await release.promise; return Response.json(imagesResponse([png(1024, 1024)])); });
    const started = summary(await imageTool("generate", { prompt: "A fox", wait_seconds: 0.02 }, f.env, ORIGIN));
    const record = f.jobs.get(started.job_id)!;
    // Simulate the platform retrying the alarm after the object restarted mid-run.
    const state = record.data.get("state") as { attempts: number };
    record.data.set("state", { ...state, attempts: 2, status: "running" });
    const fresh = new (record.job.constructor as new (...args: unknown[]) => typeof record.job)({ storage: (record.job as unknown as { ctx: DurableObjectState }).ctx.storage }, f.env);
    await fresh.alarm();
    const result = await fresh.status();
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("interrupted 2 times") });
    release.resolve();
    await settled(f, started.job_id);
  });

  it("marks a job with no result after 16 minutes as failed", async () => {
    const f = fixture();
    const release = deferred();
    mockFetch(async () => { await release.promise; return Response.json(imagesResponse([png(1024, 1024)])); });
    const started = summary(await imageTool("generate", { prompt: "A fox", wait_seconds: 0 }, f.env, ORIGIN));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 17 * 60 * 1000);
    const result = await getJobTool({ job_id: started.job_id, wait_seconds: 0 }, f.env);
    expect(text(result)).toContain("stopped without a result");
    vi.mocked(Date.now).mockRestore();
    release.resolve();
    await settled(f, started.job_id);
  });
});

describe("MCP server", () => {
  async function connect(f = fixture()) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTools(server, () => f.env, () => ORIGIN);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    return { client, f };
  }

  it("lists four tools with input and output schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["create_upload", "edit", "generate", "get_job"]);
    for (const tool of tools) expect(tool.outputSchema).toBeTruthy();
    const edit = tools.find((tool) => tool.name === "edit")!;
    expect(edit.description).toContain("create_upload");
    expect(Object.keys(edit.inputSchema.properties!)).toEqual(expect.arrayContaining([
      "prompt", "images", "mask", "markup", "n", "size", "quality", "background", "output_format", "output_compression",
      "input_fidelity", "partial_images", "safety_identifier", "preview", "wait_seconds",
    ]));
    const generate = tools.find((tool) => tool.name === "generate")!;
    expect(Object.keys(generate.inputSchema.properties!)).toEqual(expect.arrayContaining(["moderation", "n", "quality", "size"]));
    expect(JSON.stringify(generate.inputSchema)).toContain("xhigh");
  });

  it("returns structured content that validates against the output schema, with progress", async () => {
    timing.progressMs = 15;
    const { client } = await connect();
    const release = deferred();
    mockFetch(async () => { await release.promise; return Response.json(imagesResponse([png(1024, 1024)])); });
    const progress: number[] = [];
    const running = await client.callTool({ name: "generate", arguments: { prompt: "A fox", wait_seconds: 0.08 } }, undefined, {
      onprogress: (event) => progress.push(event.progress),
    });
    expect(running.structuredContent).toMatchObject({ status: "running" });
    expect(progress.length).toBeGreaterThanOrEqual(2);
    release.resolve();
    const done = await client.callTool({ name: "get_job", arguments: { job_id: (running.structuredContent as { job_id: string }).job_id } });
    expect(done.structuredContent).toMatchObject({ status: "succeeded", images: [expect.objectContaining({ width: 1024 })] });
  });

  it("validates failed results and upload results against their schemas", async () => {
    const { client } = await connect();
    mockFetch(() => Response.json({ error: { message: "Billing hard limit reached", code: "billing_hard_limit_reached" } }, { status: 400 }));
    const failed = await client.callTool({ name: "generate", arguments: { prompt: "A fox" } });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("Billing hard limit reached");
    const upload = await client.callTool({ name: "create_upload", arguments: { count: 2 } });
    expect((upload.structuredContent as { uploads: unknown[] }).uploads).toHaveLength(2);
  });

  it("accepts the warning field in the output schema and reports the token limit through SDK validation", async () => {
    const { client } = await connect();
    mockFetch(() => Response.json(imagesResponse([png(1024, 1024)], {
      usage: { input_tokens: 8, output_tokens: 10, total_tokens: 18, input_tokens_details: { image_tokens: 0, text_tokens: 8 } },
    })));
    const warned = await client.callTool({ name: "generate", arguments: { prompt: "A red fox in the snow. ".repeat(20) } });
    expect(warned.isError).toBeFalsy();
    expect((warned.structuredContent as { warning: string }).warning).toContain("most likely ignored the prompt");
    const tooLong = await client.callTool({ name: "generate", arguments: { prompt: CJK.repeat(700).slice(0, 9000) } });
    expect(tooLong.isError).toBe(true);
    expect(JSON.stringify(tooLong.content)).toContain("OpenAI silently ignores prompts over about 8,192 tokens");
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "generate")!.description).toContain("about 8,192 tokens (roughly 8,000 Chinese characters)");
    expect(JSON.stringify(tools.find((tool) => tool.name === "edit")!.inputSchema)).toContain("roughly 8,000 Chinese/Japanese/Korean characters");
  });

  it("explains local paths through the real input validation", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "edit", arguments: { prompt: "Edit", images: ["/Users/bot/cat.png"] } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("create_upload");
  });
});
