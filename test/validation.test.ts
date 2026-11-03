import { afterEach, describe, expect, it, vi } from "vitest";
import { extractBase64Fields, sniffImage } from "../src/images";
import { estimatePromptTokens, ignoredPromptWarning, PROMPT_TOKEN_LIMIT, promptTokenProblem } from "../src/prompt";
import { sizeProblem } from "../src/schemas";
import { imageTool } from "../src/tools";
import { chunked, fixture, jpeg, ORIGIN, png, webp } from "./helpers";

const IMAGE_ID = "aB0123456789cDeF012345";
afterEach(() => vi.restoreAllMocks());

function text(result: Awaited<ReturnType<typeof imageTool>>) {
  return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
}

describe("size validation", () => {
  it.each([
    "auto", "1024x1024", "1536x1024", "1024x1536", "1536x864", "2048x1152", "2560x1440",
    "3840x2160", "2160x3840", "3840x1280", "1280x3840", "3824x2160", "256x256", "512x512", "1792x1024", "1536X864",
  ])("accepts %s", (size) => {
    expect(sizeProblem(size)).toBeUndefined();
  });

  it.each([
    ["1000x1000", "multiples of 16"],
    ["1024x1000", "multiples of 16"],
    ["3840x1264", "1:3 and 3:1"],
    ["1024x3088", "1:3 and 3:1"],
    ["4096x2304", "3840 px"],
    ["2160x4096", "3840 px"],
    ["3840x2176", "8,294,400 pixels"],
    ["3520x2400", "8,294,400 pixels"],
    ["0x1024", "positive"],
    ["large", "WIDTHxHEIGHT"],
    ["1024*1024", "WIDTHxHEIGHT"],
    ["", "WIDTHxHEIGHT"],
  ])("rejects %s (%s)", async (size, message) => {
    expect(sizeProblem(size)).toContain(message);
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await imageTool("generate", { prompt: "a fox", size }, fixture().env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("size");
    expect(text(result)).toContain(message);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("prompt token estimate", () => {
  // "A red fox running through the snow," in Chinese (13 characters, including a full-width comma).
  const zh = "\u4e00\u53ea\u5728\u96ea\u5730\u91cc\u5954\u8dd1\u7684\u7ea2\u72d0\u72f8\uff0c";
  const english = "A red fox runs through deep snow at dusk, its breath visible in the cold air, while pine trees sway behind it. ";
  const chinese = (chars: number) => zh.repeat(Math.ceil(chars / zh.length)).slice(0, chars);

  it("counts CJK characters as one token each", () => {
    expect(estimatePromptTokens(chinese(8000))).toBe(8000);
    expect(estimatePromptTokens("\u3053\u3093\u306b\u3061\u306f\uc548\ub155\uff21\uff22")).toBe(9);
  });

  it("counts other text as one token per 4 UTF-8 bytes, rounded up per run", () => {
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("abcde")).toBe(2);
    expect(estimatePromptTokens("\u00e9t\u00e9")).toBe(2);
    // Short Latin runs inside CJK text cost at least one token each.
    expect(estimatePromptTokens(`${zh}4K${zh}RGB\n`)).toBe(28);
  });

  it.each([
    ["8000 Chinese characters", () => chinese(8000), true],
    ["8000 Chinese characters with 100 line breaks", () => chinese(8000).replace(/(.{80})/g, "$1\n"), true],
    ["8100 Chinese characters", () => chinese(8100), true],
    ["8101 Chinese characters", () => chinese(8101), false],
    ["9000 Chinese characters", () => chinese(9000), false],
    ["16000 Chinese characters", () => chinese(16000), false],
    ["32000 characters of English", () => english.repeat(300).slice(0, 32000), true],
    ["30000 characters of English with typographic punctuation", () => english.replace(", ", " \u2014 ").repeat(300).slice(0, 30000), true],
    ["5000 characters of English", () => english.repeat(50).slice(0, 5000), true],
  ])("%s: accepted=%s", (_name, make, accepted) => {
    const prompt = make();
    expect(promptTokenProblem(prompt) === undefined).toBe(accepted);
    expect(estimatePromptTokens(prompt) <= PROMPT_TOKEN_LIMIT).toBe(accepted);
  });

  it("stays above the measured token counts", () => {
    // Measured with OpenAI: 8000 Chinese characters = 7490 tokens, 8500 = 7958, 5000 English = 1050, 32000 English = ~6687.
    expect(estimatePromptTokens(chinese(8000))).toBeGreaterThan(7490);
    expect(estimatePromptTokens(chinese(8500))).toBeGreaterThan(7958);
    expect(estimatePromptTokens(english.repeat(50).slice(0, 5000))).toBeGreaterThan(1050);
    expect(estimatePromptTokens(english.repeat(300).slice(0, 32000))).toBeGreaterThan(6687);
  });

  it("explains the limit with the estimate", () => {
    expect(promptTokenProblem(chinese(9000))).toBe(
      "Prompt is too long: about 9,000 tokens (estimated). OpenAI silently ignores prompts over about 8,192 tokens and returns an unrelated image. " +
      "Shorten it to about 8,000 tokens: roughly 8,000 Chinese, Japanese or Korean characters, or 32,000 characters of English.",
    );
  });

  it.each([
    ["dropped long prompt", "x ".repeat(150), { input_tokens: 8 }, true],
    ["dropped prompt in an edit", "x ".repeat(150), { input_tokens: 1560, input_tokens_details: { image_tokens: 1552, text_tokens: 8 } }, true],
    ["16 tokens", "x ".repeat(150), { input_tokens: 16 }, true],
    ["17 tokens", "x ".repeat(150), { input_tokens: 17 }, false],
    ["199-character prompt", "x".repeat(199), { input_tokens: 8 }, false],
    ["no token count", "x ".repeat(150), {}, false],
  ])("low-token warning: %s -> %s", (_name, prompt, usage, warns) => {
    expect(ignoredPromptWarning(prompt, usage) !== undefined).toBe(warns);
  });
});

describe("input validation", () => {
  it.each([
    ["generate", {}, "prompt"],
    ["generate", { prompt: " \n " }, "must not be empty"],
    ["generate", { prompt: "x".repeat(32001) }, "at most 32000"],
    ["generate", { prompt: "\u{1F98A}".repeat(32001) }, "32001 characters"],
    ["generate", { prompt: "a", n: 0 }, "n"],
    ["generate", { prompt: "a", n: 11 }, "n"],
    ["generate", { prompt: "a", quality: "ultra" }, "quality"],
    ["generate", { prompt: "a", output_format: "gif" }, "output_format"],
    ["generate", { prompt: "a", background: "white" }, "background"],
    ["generate", { prompt: "a", moderation: "high" }, "moderation"],
    ["generate", { prompt: "a", output_compression: 101 }, "output_compression"],
    ["generate", { prompt: "a", partial_images: 4 }, "partial_images"],
    ["generate", { prompt: "a", wait_seconds: 46 }, "wait_seconds"],
    ["generate", { prompt: "a", input_fidelity: "high" }, "input_fidelity"],
    ["generate", { prompt: "a", background: "transparent", output_format: "jpeg" }, "png or webp"],
    ["generate", { prompt: "a", output_compression: 50 }, "output_compression needs output_format jpeg or webp"],
    ["generate", { prompt: "a", output_compression: 50, output_format: "png" }, "jpeg or webp"],
    ["edit", { prompt: "a", images: [] }, "images"],
    ["edit", { prompt: "a", images: Array(17).fill(IMAGE_ID) }, "images"],
    ["edit", { prompt: "a", images: [IMAGE_ID], quality: "hd" }, "quality"],
    ["edit", { prompt: "a", images: [IMAGE_ID], moderation: "low" }, "moderation"],
    ["edit", { prompt: "a", images: [IMAGE_ID], mask: IMAGE_ID, markup: IMAGE_ID }, "markup cannot be combined with mask"],
    ["edit", { prompt: "a", images: [IMAGE_ID], input_fidelity: "max" }, "input_fidelity"],
    ["edit", { prompt: "a", images: ["http://example.com/a.png"] }, "https"],
    ["edit", { prompt: "a", images: ["https://user:pw@example.com/a.png"] }, "credentials"],
    ["edit", { prompt: "a", images: ["not-an-id"] }, "22-character id"],
  ] as const)("rejects %s %j", async (tool, raw, message) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await imageTool(tool, raw, fixture().env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["images", "/home/bot/photo.png"],
    ["images", "./photo.png"],
    ["images", "../photo.png"],
    ["images", "~/Pictures/photo.jpg"],
    ["images", "C:\\Users\\bot\\photo.png"],
    ["images", "file:///tmp/photo.png"],
    ["images", "photo.webp"],
    ["mask", "/tmp/mask.png"],
    ["markup", "file:///tmp/markup.png"],
  ])("points %s local path %s to create_upload", async (field, path) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const raw = { prompt: "Edit", images: field === "images" ? [path] : [IMAGE_ID], ...(field === "images" ? {} : { [field]: path }) };
    const result = await imageTool("edit", raw, fixture().env, ORIGIN);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("local file path");
    expect(text(result)).toContain("create_upload");
    expect(text(result)).toContain(field);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("points inline data URLs to create_upload", async () => {
    const result = await imageTool("edit", { prompt: "Edit", images: ["data:image/png;base64,AAAA"] }, fixture().env, ORIGIN);
    expect(text(result)).toContain("create_upload");
  });
});

describe("image headers", () => {
  it.each([
    ["png", png(1536, 864), { format: "png", width: 1536, height: 864 }],
    ["jpeg", jpeg(3840, 2160), { format: "jpeg", width: 3840, height: 2160 }],
    ["webp VP8", webp("VP8 ", 1024, 768), { format: "webp", width: 1024, height: 768 }],
    ["webp VP8L", webp("VP8L", 2048, 1152), { format: "webp", width: 2048, height: 1152 }],
    ["webp VP8X", webp("VP8X", 3840, 2160), { format: "webp", width: 3840, height: 2160 }],
  ])("reads %s format and dimensions", (_name, bytes, expected) => {
    expect(sniffImage(bytes)).toEqual(expected);
  });

  it.each([
    ["text", new TextEncoder().encode("hello world, not an image")],
    ["gif", new TextEncoder().encode("GIF89a\x01\x00\x01\x00")],
    ["empty", new Uint8Array()],
  ])("rejects %s", (_name, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });
});

describe("streaming base64 extraction", () => {
  async function extract(body: string, chunk: number) {
    const images: Uint8Array[] = [];
    let rest = "";
    await extractBase64Fields(chunked(body, chunk), async (bytes) => {
      images.push(bytes);
      return `#${images.length - 1}`;
    }, async (part) => { rest += part; });
    return { images, rest };
  }

  it.each([1, 3, 7, 64, 100000])("decodes images split into %i-byte chunks and keeps the remaining JSON", async (size) => {
    const a = png(1024, 1024, 1000);
    const b = jpeg(640, 480);
    const second = Buffer.from(b).toString("base64");
    expect(second).toContain("/");
    // Some JSON encoders escape "/" as "\/".
    const body = JSON.stringify({
      data: [
        { revised_prompt: 'Quoted "b64_json": "not an image" \u2014 \u72d0\u72f8 \u{1f98a}', b64_json: Buffer.from(a).toString("base64") },
        { b64_json: second },
      ],
      usage: { total_tokens: 3 },
    }, null, 2).replace(second, second.replaceAll("/", "\\/"));
    const { images, rest } = await extract(body, size);
    expect(images.map((bytes) => Buffer.from(bytes))).toEqual([Buffer.from(a), Buffer.from(b)]);
    const parsed = JSON.parse(rest);
    expect(parsed.data.map((item: { b64_json: string }) => item.b64_json)).toEqual(["#0", "#1"]);
    expect(parsed.data[0].revised_prompt).toBe('Quoted "b64_json": "not an image" \u2014 \u72d0\u72f8 \u{1f98a}');
    expect(parsed.usage).toEqual({ total_tokens: 3 });
  });

  it("fails clearly on a truncated image", async () => {
    await expect(extract('{"data":[{"b64_json":"iVBORw0KGgo', 5)).rejects.toThrow("middle of an image");
  });
});
