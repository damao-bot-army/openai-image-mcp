import { z } from "zod";
import { ID, MiB } from "./images";
import { promptTokenProblem } from "./prompt";

// Limits from openai@7.47.0 resources/images.d.ts, except totalInputBytes, which keeps one
// edit's inputs inside the 128 MB Durable Object memory limit.
export const LIMITS = {
  promptChars: 32000,
  n: 10,
  inputImages: 16,
  maxEdge: 3840,
  maxPixels: 3840 * 2160,
  maxAspect: 3,
  edgeMultiple: 16,
  partialImages: 3,
  imageBytes: 50 * MiB,
  maskBytes: 4 * MiB,
  totalInputBytes: 64 * MiB,
  maxWaitSeconds: 45,
} as const;

export const JOB_ID = /^job_[A-Za-z0-9]{22}$/;

export function sizeProblem(size: string): string | undefined {
  if (size === "auto") return;
  const match = /^(\d{1,5})[xX](\d{1,5})$/.exec(size);
  if (!match) return `Use "auto" or WIDTHxHEIGHT such as 1536x864 (got ${JSON.stringify(size)})`;
  const [width, height] = [Number(match[1]), Number(match[2])];
  if (!width || !height) return "Width and height must be positive";
  if (width % LIMITS.edgeMultiple || height % LIMITS.edgeMultiple) return `Width and height must both be multiples of 16 (got ${size})`;
  if (Math.max(width, height) > LIMITS.maxAspect * Math.min(width, height)) return `Aspect ratio must be between 1:3 and 3:1 (got ${size})`;
  if (Math.max(width, height) > LIMITS.maxEdge) return `Each edge must be at most 3840 px (got ${size})`;
  if (width * height > LIMITS.maxPixels) return `At most 8,294,400 pixels (3840x2160) are supported (got ${size} = ${width * height})`;
}

const short = (value: string) => JSON.stringify(value.length > 120 ? `${value.slice(0, 117)}...` : value);
const UPLOAD_HINT = "call create_upload, run its curl command with the file, then pass the returned id";
export function referenceProblem(value: string): string | undefined {
  if (ID.test(value)) return;
  const local = `${short(value)} is a local file path; this server cannot read your files. To use a local image, ${UPLOAD_HINT}`;
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^(~|\.{1,2})?[\\/]/.test(value) || value.startsWith("~")) return local;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return /[\\/]|\.[a-z0-9]{2,5}$/i.test(value) ? local
      : `${short(value)} is not an image reference. Use a 22-character id from generate, edit or create_upload, or a public https URL`;
  }
  if (url.protocol === "file:") return local;
  if (url.protocol === "data:") return `Inline data URLs are not accepted; ${UPLOAD_HINT}`;
  if (url.protocol !== "https:") return `Use a public https URL (got ${url.protocol} in ${short(value)})`;
  if (url.username || url.password) return `Remove the credentials from ${short(value)}`;
}

function check<T>(schema: z.ZodType<T>, problem: (value: T) => string | undefined) {
  return schema.superRefine((value, ctx) => {
    const message = problem(value);
    if (message) ctx.addIssue({ code: "custom", message });
  });
}

const prompt = check(z.string(), (value) => {
  if (!value.trim()) return "Prompt must not be empty";
  let chars = 0;
  for (const _ of value) chars++;
  if (chars > LIMITS.promptChars) return `Prompt has ${chars} characters; the model accepts at most 32000`;
  return promptTokenProblem(value);
}).describe(
  "What to create or change. Up to about 8,000 tokens (OpenAI silently ignores longer prompts): roughly 8,000 Chinese/Japanese/Korean characters or 32,000 English characters.",
);

const reference = check(z.string(), referenceProblem);

const size = check(z.string(), sizeProblem).optional().describe(
  "\"auto\" (default) or WIDTHxHEIGHT, e.g. 1024x1024, 1536x1024, 1024x1536, 2048x1152, 3840x2160. Both edges multiples of 16, aspect ratio 1:3 to 3:1, each edge <= 3840, <= 8,294,400 pixels. Above 2560x1440 is experimental.",
);
const qualityNote = "Default auto. GPT image models: low, medium, high; gpt-image-2.5 models also xhigh and max. standard";
const output = {
  n: z.number().int().min(1).max(LIMITS.n).optional().describe("Number of images, 1-10. Default 1."),
  background: z.enum(["transparent", "opaque", "auto"]).optional().describe("Default auto. transparent needs output_format png or webp."),
  output_format: z.enum(["png", "jpeg", "webp"]).optional().describe("Default png."),
  output_compression: z.number().int().min(0).max(100).optional().describe("0-100 (default 100). Only with output_format jpeg or webp."),
};
const extras = {
  partial_images: z.number().int().min(0).max(LIMITS.partialImages).optional().describe(
    "0-3. Streams this many progressive partial images while the job runs; they are stored and listed in partial_images. Default 0.",
  ),
  safety_identifier: z.string().optional().describe("Stable end-user identifier (e.g. a hash) for OpenAI abuse monitoring."),
  preview: z.boolean().optional().describe("Also return 512px JPEG previews as inline image content. Default false; the url is usually enough."),
  wait_seconds: z.number().min(0).max(LIMITS.maxWaitSeconds).optional().describe(
    "How long to wait for the result before returning a job_id, 0-45. Default 45. Use 0 to start several jobs in parallel.",
  ),
};

export const generateShape = {
  prompt,
  size,
  quality: z.enum(["low", "medium", "high", "xhigh", "max", "auto", "standard", "hd"]).optional()
    .describe(`${qualityNote} and hd are legacy values.`),
  ...output,
  moderation: z.enum(["low", "auto"]).optional().describe("Content moderation level: auto (default) or low (less restrictive)."),
  ...extras,
};

export const editShape = {
  prompt,
  images: z.array(reference).min(1).max(LIMITS.inputImages).describe(
    "1-16 input images: ids from generate/edit/create_upload, or public https URLs. PNG, JPEG or WebP, each < 50 MiB, 64 MiB in total.",
  ),
  mask: reference.optional().describe(
    "PNG (< 4 MiB, same size as the first image) whose fully transparent pixels mark where to edit. Same reference forms as images.",
  ),
  markup: reference.optional().describe(
    "Transparent PNG drawn over the first image (same size) to guide the edit, e.g. circles or arrows. Cannot be combined with mask.",
  ),
  input_fidelity: z.enum(["high", "low"]).optional().describe(
    "How closely to preserve input details, especially faces. Model-dependent; omitted unless set.",
  ),
  size,
  quality: z.enum(["low", "medium", "high", "xhigh", "max", "auto", "standard"]).optional()
    .describe(`${qualityNote} is a legacy value.`),
  ...output,
  ...extras,
};

export const generateSchema = z.strictObject(generateShape);
export const editSchema = z.strictObject(editShape);
export type GenerateInput = z.infer<typeof generateSchema>;
export type EditInput = z.infer<typeof editSchema>;
export type ImageInput = GenerateInput | EditInput;

/** Cross-field rules from the OpenAI parameter documentation. */
export function combinationProblem(input: ImageInput): string | undefined {
  if (input.background === "transparent" && input.output_format === "jpeg") {
    return "background transparent needs output_format png or webp";
  }
  if (input.output_compression !== undefined && input.output_format !== "jpeg" && input.output_format !== "webp") {
    return "output_compression needs output_format jpeg or webp";
  }
  if ("markup" in input && input.markup && input.mask) return "markup cannot be combined with mask";
}

export const getJobShape = {
  job_id: z.string().regex(JOB_ID, "Use the job_id returned by generate or edit (job_ followed by 22 characters)")
    .describe("The job_id returned by generate or edit."),
  wait_seconds: z.number().min(0).max(LIMITS.maxWaitSeconds).optional().describe("Wait up to this long for the job to finish, 0-45. Default 45."),
  preview: z.boolean().optional().describe("Return 512px JPEG previews. Defaults to the value used when the job was started."),
};
export const getJobSchema = z.strictObject(getJobShape);

export const createUploadShape = {
  count: z.number().int().min(1).max(LIMITS.inputImages + 2).optional().describe("Number of upload URLs (one per file). Default 1."),
};
export const createUploadSchema = z.strictObject(createUploadShape);

const imageOutput = {
  id: z.string(),
  url: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  format: z.enum(["png", "jpeg", "webp"]),
  bytes: z.number().int(),
};
export const jobOutputShape = {
  job_id: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  images: z.array(z.object({ ...imageOutput, revised_prompt: z.string().optional() })).optional(),
  partial_images: z.array(z.object({ ...imageOutput, index: z.number().int() })).optional(),
  model: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).nullable().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  resolved: z.record(z.string(), z.unknown()).optional(),
  elapsed_seconds: z.number().optional(),
  error: z.string().optional(),
  warning: z.string().optional(),
  next: z.string(),
};

export const uploadOutputShape = {
  uploads: z.array(z.object({ id: z.string(), upload_url: z.string(), curl: z.string() })),
  method: z.literal("PUT"),
  expires_at: z.string(),
  max_bytes: z.number().int(),
  next: z.string(),
};
