import { DEFAULT_OPENAI_BASE_URL, type Env } from "./env";
import { extractBase64Fields, findImage, FORMATS, type Format, ID, MiB, randomId, sniffImage } from "./images";
import { ignoredPromptWarning } from "./prompt";
import { type EditInput, LIMITS } from "./schemas";

export type Tool = "generate" | "edit";
/** Validated tool input without the MCP-only fields (preview, wait_seconds). */
export type JobInput = Record<string, unknown> & { prompt: string; images?: string[]; mask?: string; markup?: string };
export interface JobRequest {
  job_id: string;
  tool: Tool;
  input: JobInput;
  origin: string;
  model: string;
  created_at: string;
}
export interface StoredImage {
  id: string;
  key: string;
  url: string;
  width: number | null;
  height: number | null;
  format: Format;
  bytes: number;
  revised_prompt?: string;
  index?: number;
}
export interface JobResult {
  images: StoredImage[];
  partial_images: StoredImage[];
  model: string;
  usage: Record<string, unknown> | null;
  params: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  warning?: string;
}

export const OPENAI_TIMEOUT_MS = 10 * 60 * 1000;
const NOT_PARAMS = new Set(["prompt", "images", "mask", "markup"]);

/** The OpenAI parameters a job sends besides model, prompt and input images. */
export function requestParams(input: JobInput): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (NOT_PARAMS.has(key) || value === undefined) continue;
    params[key] = key === "size" ? String(value).toLowerCase() : value as string | number;
  }
  return params;
}

interface OpenAIError { code?: string | null; message?: string; param?: string | null; type?: string }
function describeError(status: number | undefined, error: OpenAIError | undefined, fallback: string): string {
  const where = status === undefined ? "OpenAI stream error" : `OpenAI HTTP ${status}`;
  return `${where}${error?.code ? ` [${error.code}]` : ""}${error?.param ? ` (${error.param})` : ""}: ${error?.message || fallback}`;
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: OpenAIError };
    return new Error(describeError(response.status, body.error, text.slice(0, 2000)));
  } catch {
    return new Error(`OpenAI HTTP ${response.status}: ${text.slice(0, 2000) || response.statusText}`);
  }
}

// ---- Input images -------------------------------------------------------------------------

interface ResolvedInput { blob: Blob; format: Format; bytes: number }
class BudgetError extends Error {}

/** Returns why `bytes` more input would not fit, or undefined if it fits. */
function inputProblem(budget: { used: number }, bytes: number, ref: string): Error | undefined {
  if (bytes > LIMITS.imageBytes) return new Error(`image is ${(bytes / MiB).toFixed(1)} MiB; each input must be under 50 MiB`);
  if (budget.used + bytes > LIMITS.totalInputBytes) {
    return new BudgetError(`Input images exceed the 64 MiB total for one edit (${((budget.used + bytes) / MiB).toFixed(1)} MiB including ${JSON.stringify(ref)}); use fewer or smaller images`);
  }
}

function ownImageId(ref: string, origin: string): string | undefined {
  if (ID.test(ref)) return ref;
  try {
    const url = new URL(ref);
    if (url.origin !== origin) return;
    return /^\/img\/([A-Za-z0-9]{22})(?:\.[a-z]+)?$/.exec(url.pathname)?.[1];
  } catch { return; }
}

function asInput(bytes: Uint8Array, detail: string): ResolvedInput {
  const info = sniffImage(bytes);
  if (!info) throw new Error(`not a PNG, JPEG or WebP image${detail}`);
  return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: FORMATS[info.format] }), format: info.format, bytes: bytes.byteLength };
}

async function download(ref: string, budget: { used: number }): Promise<ResolvedInput> {
  let url = new URL(ref);
  for (let redirects = 0; redirects <= 3; redirects++) {
    // The Workers strictly-public fetch flag also rejects private DNS destinations.
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") || url.hostname.includes(":") || /^[\d.]+$/.test(url.hostname)) {
      throw new Error("use a public https image URL without credentials or IP literals");
    }
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect has no Location header");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}; make the image publicly downloadable`);
    }
    if (!response.body) throw new Error("empty response body");
    const declared = inputProblem(budget, Number(response.headers.get("content-length") ?? 0), ref);
    if (declared) {
      await response.body.cancel();
      throw declared;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      const problem = inputProblem(budget, total, ref);
      if (problem) {
        await reader.cancel();
        throw problem;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    budget.used += total;
    return asInput(bytes, ` (content-type ${response.headers.get("content-type") || "missing"})`);
  }
  throw new Error("too many redirects; supply the final public image URL");
}

export async function resolveInput(ref: string, env: Env, origin: string, budget: { used: number }): Promise<ResolvedInput> {
  try {
    const id = ownImageId(ref, origin);
    if (!id) return await download(ref, budget);
    const object = await findImage(env.IMAGES_BUCKET, id);
    if (!object) throw new Error("not found; images expire after 30 days, so generate or upload it again");
    const problem = inputProblem(budget, object.size, ref);
    if (problem) {
      await object.body.cancel();
      throw problem;
    }
    budget.used += object.size;
    return asInput(new Uint8Array(await object.arrayBuffer()), "");
  } catch (error) {
    if (error instanceof BudgetError) throw error;
    throw new Error(`Cannot use image ${JSON.stringify(ref)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function editForm(request: JobRequest, env: Env, params: Record<string, string | number | boolean>): Promise<FormData> {
  const input = request.input as EditInput;
  const budget = { used: 0 };
  const form = new FormData();
  form.set("model", request.model);
  form.set("prompt", input.prompt);
  for (const [key, value] of Object.entries(params)) form.set(key, String(value));
  for (const [index, ref] of input.images.entries()) {
    const image = await resolveInput(ref, env, request.origin, budget);
    form.append("image[]", image.blob, `image-${index + 1}.${image.format}`);
  }
  for (const field of ["mask", "markup"] as const) {
    const ref = input[field];
    if (!ref) continue;
    const image = await resolveInput(ref, env, request.origin, budget);
    if (image.format !== "png") throw new Error(`${field} must be a PNG image (got ${image.format})`);
    if (field === "mask" && image.bytes >= LIMITS.maskBytes) throw new Error(`mask must be smaller than 4 MiB (got ${(image.bytes / MiB).toFixed(1)} MiB)`);
    form.set(field, image.blob, `${field}.png`);
  }
  return form;
}

// ---- Request and response -----------------------------------------------------------------

async function send(request: JobRequest, env: Env, params: Record<string, string | number | boolean>): Promise<Response> {
  const base = (env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const headers = new Headers({ Authorization: `Bearer ${env.OPENAI_API_KEY}` });
  let body: string | FormData;
  if (request.tool === "edit") {
    body = await editForm(request, env, params);
  } else {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify({ model: request.model, prompt: request.input.prompt, ...params });
  }
  try {
    return await fetch(`${base}/images/${request.tool === "edit" ? "edits" : "generations"}`, {
      method: "POST", headers, body, signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("OpenAI did not respond within 10 minutes; try again, or use a smaller size or lower quality");
    }
    throw new Error(`OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const RESOLVED_FIELDS = ["size", "quality", "background", "output_format"] as const;
function pickResolved(source: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = RESOLVED_FIELDS.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

interface ImagesResponse {
  data?: { b64_json?: string; revised_prompt?: string }[];
  usage?: Record<string, unknown>;
  model?: string;
  error?: OpenAIError;
  [key: string]: unknown;
}
interface StreamEvent {
  type?: string;
  b64_json?: string;
  partial_image_index?: number;
  usage?: Record<string, unknown>;
  error?: OpenAIError;
  [key: string]: unknown;
}

/** Calls OpenAI for one job, stores every returned image in R2 and writes meta/<id>.json. */
export async function runImageJob(
  request: JobRequest,
  env: Env,
  onPartial?: (image: StoredImage) => Promise<void>,
): Promise<JobResult> {
  const params = requestParams(request.input);
  // partial_images only works on the streaming endpoint; otherwise one JSON response is simpler.
  const streaming = Number(params.partial_images ?? 0) > 0;
  const response = await send(request, env, streaming ? { ...params, stream: true } : params);
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error(`OpenAI HTTP ${response.status}: empty response body`);

  const created = new Date().toISOString();
  const promptPreview = [...request.input.prompt.slice(0, 400)].slice(0, 200).join("");
  const stored: StoredImage[] = [];
  const storeImage = async (bytes: Uint8Array) => {
    const info = sniffImage(bytes);
    const format = info?.format ?? (request.input.output_format as Format | undefined) ?? "png";
    const id = randomId();
    const key = `img/${id}.${format}`;
    await env.IMAGES_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: FORMATS[format] },
      customMetadata: {
        source: request.tool,
        "job-id": request.job_id,
        model: request.model,
        size: info?.width && info.height ? `${info.width}x${info.height}` : "unknown",
        "created-at": created,
        "prompt-preview": promptPreview,
      },
    });
    stored.push({ id, key, url: `${request.origin}/img/${id}`, width: info?.width ?? null, height: info?.height ?? null, format, bytes: bytes.byteLength });
    return `#${stored.length - 1}`;
  };
  const placeholder = (value: unknown) => {
    const match = typeof value === "string" ? /^#(\d+)$/.exec(value) : null;
    return match ? stored[Number(match[1])] : undefined;
  };

  const images: StoredImage[] = [];
  const partials: StoredImage[] = [];
  let usage: Record<string, unknown> | null = null;
  let resolved: Record<string, unknown> | undefined;
  let model = request.model;
  const isStream = streaming || (response.headers.get("content-type") ?? "").includes("text/event-stream");
  try {
    if (isStream) {
      let buffer = "";
      const handleEvent = async (raw: string) => {
        const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") return;
        const event = JSON.parse(data) as StreamEvent;
        if (event.type === "error" || event.error) throw new Error(describeError(undefined, event.error, data.slice(0, 2000)));
        const image = placeholder(event.b64_json);
        if (!image) return;
        if (event.type?.endsWith("partial_image")) {
          image.index = event.partial_image_index ?? partials.length;
          partials.push(image);
          await onPartial?.(image);
        } else if (event.type?.endsWith("completed")) {
          images.push(image);
          usage = event.usage ?? usage;
          resolved = pickResolved(event) ?? resolved;
          if (typeof event.model === "string") model = event.model;
        }
      };
      await extractBase64Fields(response.body, storeImage, async (text) => {
        buffer += text;
        for (let match = /\r?\n\r?\n/.exec(buffer); match; match = /\r?\n\r?\n/.exec(buffer)) {
          const raw = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          await handleEvent(raw);
        }
      });
      if (buffer.trim()) await handleEvent(buffer);
    } else {
      let text = "";
      await extractBase64Fields(response.body, storeImage, async (chunk) => { text += chunk; });
      let body: ImagesResponse;
      try {
        body = JSON.parse(text) as ImagesResponse;
      } catch {
        throw new Error(`OpenAI HTTP ${response.status}: invalid JSON response: ${text.slice(0, 500)}`);
      }
      if (body.error) throw new Error(describeError(response.status, body.error, text.slice(0, 2000)));
      for (const item of body.data ?? []) {
        const image = placeholder(item.b64_json);
        if (!image) continue;
        if (item.revised_prompt) image.revised_prompt = item.revised_prompt;
        images.push(image);
      }
      usage = body.usage ?? null;
      resolved = pickResolved(body);
      if (typeof body.model === "string") model = body.model;
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`OpenAI returned an unreadable response: ${error.message}`);
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("OpenAI did not finish within 10 minutes; try again, or use a smaller size or lower quality");
    }
    throw error;
  }
  if (!images.length) throw new Error("OpenAI returned no images; adjust the prompt and try again");
  const warning = ignoredPromptWarning(request.input.prompt, usage);

  const inputs = request.tool === "edit"
    ? { images: request.input.images, ...(request.input.mask ? { mask: request.input.mask } : {}), ...(request.input.markup ? { markup: request.input.markup } : {}) }
    : undefined;
  await Promise.all(images.map((image, index) => env.IMAGES_BUCKET.put(`meta/${image.id}.json`, JSON.stringify({
    id: image.id,
    url: image.url,
    job_id: request.job_id,
    tool: request.tool,
    index,
    created_at: created,
    model,
    prompt: request.input.prompt,
    params,
    ...(inputs ? { inputs } : {}),
    revised_prompt: image.revised_prompt ?? null,
    usage,
    resolved: resolved ?? null,
    warning: warning ?? null,
    image: { width: image.width, height: image.height, format: image.format, content_type: FORMATS[image.format], bytes: image.bytes },
  }, null, 2), { httpMetadata: { contentType: "application/json" } })));
  return { images, partial_images: partials, model, usage, params, ...(resolved ? { resolved } : {}), ...(warning ? { warning } : {}) };
}
