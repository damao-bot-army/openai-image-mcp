import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULT_MODEL, type Env } from "./env";
import { base64, randomId } from "./images";
import { isFinished, type JobApi, type JobState, jobStub } from "./jobs";
import type { JobInput, JobRequest, StoredImage, Tool } from "./openai";
import {
  combinationProblem, createUploadSchema, createUploadShape, editSchema, editShape, generateSchema, generateShape,
  getJobSchema, getJobShape, jobOutputShape, LIMITS, uploadOutputShape,
} from "./schemas";
import { createUploads } from "./upload";

/** The parts of the MCP request context the tools use. */
export interface ToolExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

export const timing = { progressMs: 10_000 };

function errorResult(error: unknown): CallToolResult {
  const text = error instanceof z.ZodError
    ? `Invalid input: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`
    : error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text }] };
}

const elapsed = (state: JobState) => Math.max(0, Math.round((Date.now() - Date.parse(state.created_at)) / 1000));
const publicImage = ({ key: _key, ...image }: StoredImage) => image;

function summarize(tool: Tool, input: JobInput): string {
  const parts = ["n", "size", "quality", "output_format"].filter((key) => input[key] !== undefined).map((key) => `${key}=${input[key]}`);
  if (input.images) parts.unshift(`${input.images.length} input image${input.images.length > 1 ? "s" : ""}`);
  return `${tool}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** Waits up to `waitMs` for the job, sending MCP progress notifications about every 10 s. */
async function waitForJob(stub: JobApi, waitMs: number, extra?: ToolExtra): Promise<JobState | null> {
  const deadline = Date.now() + waitMs;
  const token = extra?._meta?.progressToken;
  let progress = 0;
  let state = await stub.status();
  const notify = async (current: JobState) => {
    if (token === undefined || !extra?.sendNotification) return;
    progress = Math.max(progress + 1, elapsed(current));
    const partial = current.partial_images.at(-1);
    const message = `${current.id} ${current.status === "queued" ? "queued" : "running"} for ${elapsed(current)} s: ${current.summary}` +
      (partial ? `; partial image ${current.partial_images.length}: ${partial.url}` : "");
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, message } }).catch(() => {});
  };
  // Stop waiting as soon as the client cancels or disconnects; the job itself keeps running.
  const signal = extra?.signal;
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal?.aborted) resolve("aborted");
    signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  if (state && !isFinished(state) && waitMs > 0) await notify(state);
  while (state && !isFinished(state) && Date.now() < deadline) {
    const next = await Promise.race([stub.wait(Math.min(timing.progressMs, deadline - Date.now())), aborted]);
    if (next === "aborted") break;
    state = next;
    if (state && !isFinished(state) && Date.now() < deadline) await notify(state);
  }
  return state;
}

async function previewBlocks(images: StoredImage[], env: Env, warnings: string[]): Promise<CallToolResult["content"]> {
  if (!env.IMAGES) {
    warnings.push("Previews need the Images binding; use the url instead.");
    return [];
  }
  const blocks: CallToolResult["content"] = [];
  for (const image of images) {
    try {
      const object = await env.IMAGES_BUCKET.get(image.key);
      if (!object) throw new Error("missing");
      const output = await env.IMAGES.input(object.body).transform({ width: 512, height: 512, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 75 });
      blocks.push({ type: "image", mimeType: "image/jpeg", data: base64(new Uint8Array(await output.response().arrayBuffer())) });
    } catch {
      warnings.push(`Preview unavailable for ${image.id}; use its url.`);
    }
  }
  return blocks;
}

export async function jobResult(state: JobState, env: Env, preview: boolean): Promise<CallToolResult> {
  const partials = state.partial_images.length
    ? { partial_images: state.partial_images.map((image) => ({ ...publicImage(image), index: image.index ?? 0 })) }
    : {};
  if (state.status === "failed") {
    const summary = {
      job_id: state.id, status: "failed" as const, error: state.error ?? "unknown error",
      next: "Nothing was generated. Fix the request based on the error, then call generate or edit again.",
    };
    return { isError: true, content: [{ type: "text", text: `Job ${state.id} failed: ${summary.error}` }], structuredContent: summary };
  }
  if (state.status !== "succeeded" || !state.result) {
    const summary = {
      job_id: state.id, status: "running" as const, elapsed_seconds: elapsed(state), ...partials,
      next: `Still running. Call get_job with job_id "${state.id}" to wait for the result (each call waits up to 45 s).`,
    };
    return { content: [{ type: "text", text: JSON.stringify(summary) }], structuredContent: summary };
  }
  const { result } = state;
  const first = result.images[0];
  const warnings = result.warning ? [result.warning] : [];
  const blocks = preview ? await previewBlocks(result.images, env, warnings) : [];
  const summary = {
    job_id: state.id,
    status: "succeeded" as const,
    images: result.images.map(publicImage),
    ...partials,
    model: result.model,
    usage: result.usage,
    params: result.params,
    ...(result.resolved ? { resolved: result.resolved } : {}),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    next: `To keep editing, call edit with images: ["${first.id}"] (use any returned id). To save a file: curl -o ${first.id}.${first.format} ${first.url}`,
  };
  return { content: [{ type: "text", text: JSON.stringify(summary) }, ...blocks], structuredContent: summary };
}

export async function imageTool(tool: Tool, raw: unknown, env: Env, origin: string, extra?: ToolExtra): Promise<CallToolResult> {
  try {
    const { preview = false, wait_seconds = LIMITS.maxWaitSeconds, ...input } = (tool === "generate" ? generateSchema : editSchema).parse(raw);
    const problem = combinationProblem(input);
    if (problem) throw new Error(`Invalid input: ${problem}`);
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing; set it with wrangler secret put OPENAI_API_KEY");
    const request: JobRequest = {
      job_id: `job_${randomId()}`, tool, input, origin,
      model: env.IMAGE_MODEL || DEFAULT_MODEL, created_at: new Date().toISOString(),
    };
    const stub = jobStub(env, request.job_id);
    await stub.start(request, preview, summarize(tool, input));
    const state = await waitForJob(stub, wait_seconds * 1000, extra);
    if (!state) throw new Error(`Job ${request.job_id} could not be started`);
    return await jobResult(state, env, preview);
  } catch (error) {
    return errorResult(error);
  }
}

export async function getJobTool(raw: unknown, env: Env, extra?: ToolExtra): Promise<CallToolResult> {
  try {
    const input = getJobSchema.parse(raw);
    const state = await waitForJob(jobStub(env, input.job_id), (input.wait_seconds ?? LIMITS.maxWaitSeconds) * 1000, extra);
    if (!state) throw new Error(`Unknown job_id ${input.job_id}; jobs are kept for 30 days`);
    return await jobResult(state, env, input.preview ?? state.preview);
  } catch (error) {
    return errorResult(error);
  }
}

export async function createUploadTool(raw: unknown, env: Env, origin: string): Promise<CallToolResult> {
  try {
    const summary = await createUploads(env, origin, createUploadSchema.parse(raw).count ?? 1);
    return { content: [{ type: "text", text: JSON.stringify(summary) }], structuredContent: { ...summary } };
  } catch (error) {
    return errorResult(error);
  }
}

const ASYNC_NOTE = "Waits up to wait_seconds (default 45) and sends progress notifications. If the job is still running it returns {job_id, status: \"running\"}; then call get_job with that job_id. The job keeps running even if you disconnect.";
const RESULT_NOTE = "Result: per image id, public url, width, height, format, bytes (and revised_prompt if any), plus model, usage, params and a warning if something looks wrong. Download with curl -o FILE URL; pass an id to edit to keep refining.";
const PROMPT_NOTE = "Prompts are limited to about 8,192 tokens (roughly 8,000 Chinese characters); OpenAI silently ignores longer ones, so longer prompts are rejected.";

export function registerTools(server: McpServer, env: () => Env, origin: () => string) {
  server.registerTool("generate", {
    title: "Generate images",
    description: `Create images from a text prompt with the OpenAI image model. Supports any size up to 3840x2160, quality up to max, 1-10 images, transparent backgrounds, png/jpeg/webp. ${PROMPT_NOTE} ${RESULT_NOTE} ${ASYNC_NOTE}`,
    inputSchema: generateShape,
    outputSchema: jobOutputShape,
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, (input, extra) => imageTool("generate", input, env(), origin(), extra));
  server.registerTool("edit", {
    title: "Edit images",
    description: `Edit or combine 1-16 images with a prompt. images, mask and markup take ids (from generate, edit or create_upload) or public https URLs. Local files: call create_upload, run its curl command with the file path, then pass the returned id. Optional mask (transparent = area to change) or markup (drawn guidance) applies to the first image. ${PROMPT_NOTE} ${RESULT_NOTE} ${ASYNC_NOTE}`,
    inputSchema: editShape,
    outputSchema: jobOutputShape,
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, (input, extra) => imageTool("edit", input, env(), origin(), extra));
  server.registerTool("get_job", {
    title: "Get job result",
    description: "Wait for a generate/edit job that returned status \"running\" and return its result (same format as generate/edit). Waits up to wait_seconds (default 45) with progress notifications; call again while it is still running. A failed job returns the OpenAI error.",
    inputSchema: getJobShape,
    outputSchema: jobOutputShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (input, extra) => getJobTool(input, env(), extra));
  server.registerTool("create_upload", {
    title: "Upload local images",
    description: "Get one-time upload URLs for local image files so edit can use them. Run the returned curl command with your file path in a shell (no token needed); it responds with JSON containing the image id. Pass that id in edit's images, mask or markup. PNG, JPEG or WebP, up to 50 MiB, URL valid 15 minutes. Use count for several files.",
    inputSchema: createUploadShape,
    outputSchema: uploadOutputShape,
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, (input) => createUploadTool(input, env(), origin()));
}
