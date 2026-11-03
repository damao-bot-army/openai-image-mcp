import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
  type OAuthResourceAuth,
  insufficientScope,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

export interface Env {
  IMAGE_MCP: DurableObjectNamespace;
  IMAGES_BUCKET: R2Bucket;
  IMAGES?: ImagesBinding;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OPENAI_API_KEY: string;
  AUTH_PASSWORD: string;
  IMAGE_MODEL?: string;
}

// Confirmed in openai@7.47.0 resources/images.d.ts.
const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const ID = /^[A-Za-z0-9]{22}$/;
const formats = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
const options = {
  prompt: z.string().trim().min(1).refine(
    (value) => new TextEncoder().encode(value).byteLength <= 1500,
    "Shorten prompt to at most 1500 UTF-8 bytes so the complete prompt fits in R2 custom metadata",
  ),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("auto"),
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
  background: z.enum(["transparent", "opaque", "auto"]).default("auto"),
  output_format: z.enum(["png", "jpeg", "webp"]).default("png"),
};
const reference = z.string().min(1).refine((value) => {
  if (ID.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Use a 22-character image ID from a previous result or an https URL without credentials");
const generateSchema = z.strictObject({ ...options, n: z.number().int().min(1).max(4).default(1) });
const editSchema = z.strictObject({ ...options, images: z.array(reference).min(1).max(16), mask: reference.optional() });

function randomId(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let id = "";
  // Rejection sampling avoids modulo bias.
  while (id.length < 22) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && id.length < 22) id += alphabet[byte % 62];
    }
  }
  return id;
}

async function findImage(bucket: R2Bucket, id: string): Promise<R2ObjectBody | null> {
  if (!ID.test(id)) return null;
  for (const ext of Object.keys(formats)) {
    const object = await bucket.get(`img/${id}.${ext}`);
    if (object) return object;
  }
  return null;
}

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
async function resolveImage(value: string, env: Env): Promise<Blob> {
  try {
    if (ID.test(value)) {
      const object = await findImage(env.IMAGES_BUCKET, value);
      if (!object) throw new Error("not found in R2; use an ID from a previous result (images may expire after 30 days)");
      return new Blob([await object.arrayBuffer()], { type: object.httpMetadata?.contentType ?? "image/png" });
    }
    let url = new URL(value);
    for (let redirects = 0; redirects <= 3; redirects++) {
      // The Workers strictly-public fetch flag also rejects private DNS destinations.
      if (url.protocol !== "https:" || url.username || url.password ||
          url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
          url.hostname.includes(":") || /^[\d.]+$/.test(url.hostname)) {
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
      const type = response.headers.get("content-type")?.split(";")[0] ?? "";
      if (!["image/png", "image/jpeg", "image/webp"].includes(type)) {
        await response.body?.cancel();
        throw new Error(`expected PNG, JPEG, or WebP, received ${type || "no content-type"}`);
      }
      if (!response.body) throw new Error("empty response body");
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let total = 0;
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        total += chunk.byteLength;
        if (total > MAX_INPUT_BYTES) {
          await reader.cancel();
          throw new Error("image exceeds the 50 MiB input limit; supply a smaller image");
        }
        chunks.push(chunk);
      }
      return new Blob(chunks, { type });
    }
    throw new Error("too many redirects; supply the final public image URL");
  } catch (error) {
    throw new Error(`Cannot resolve image ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

interface OpenAIResponse {
  data?: { b64_json?: string }[];
  usage?: unknown;
  model?: string;
  size?: string;
  error?: { code?: string; message?: string; param?: string };
}

export async function runTool(name: "generate" | "edit", raw: unknown, env: Env, origin: string): Promise<CallToolResult> {
  try {
    const input = (name === "generate" ? generateSchema : editSchema).parse(raw);
    if (input.background === "transparent" && input.output_format === "jpeg") {
      throw new Error("output_format: jpeg cannot represent background: transparent; choose png or webp");
    }
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing; set it with wrangler secret put OPENAI_API_KEY");
    const model = env.IMAGE_MODEL || DEFAULT_MODEL;
    const headers = new Headers({ Authorization: `Bearer ${env.OPENAI_API_KEY}` });
    let body: string | FormData;
    if ("images" in input) {
      const form = new FormData();
      for (const [key, value] of Object.entries(input)) {
        if (key !== "images" && key !== "mask") form.set(key, String(value));
      }
      form.set("model", model);
      for (const [index, value] of input.images.entries()) {
        const blob = await resolveImage(value, env);
        const ext = Object.entries(formats).find(([, type]) => type === blob.type)?.[0] ?? "png";
        form.append("image[]", blob, `input-${index}.${ext}`);
      }
      if (input.mask) form.set("mask", await resolveImage(input.mask, env), "mask.png");
      body = form;
    } else {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify({ ...input, model });
    }
    const response = await fetch(`https://api.openai.com/v1/images/${name === "generate" ? "generations" : "edits"}`, {
      method: "POST", headers, body, signal: AbortSignal.timeout(180000),
    });
    const text = await response.text();
    let result: OpenAIResponse;
    try { result = JSON.parse(text) as OpenAIResponse; }
    catch { throw new Error(`OpenAI HTTP ${response.status}: invalid JSON response; retry or check OpenAI service status`); }
    if (!response.ok || result.error) {
      throw new Error(`OpenAI HTTP ${response.status} [${result.error?.code ?? "unknown_code"}]${result.error?.param ? ` (${result.error.param})` : ""}: ${result.error?.message ?? "No error message returned; check the API key, model access, and OpenAI service status"}`);
    }
    if (!result.data?.length) throw new Error("OpenAI returned no images; retry with a different prompt");
    const content: CallToolResult["content"] = [];
    const images: { id: string; url: string; preview: boolean }[] = [];
    const warnings: string[] = [];
    for (const item of result.data) {
      if (!item.b64_json) throw new Error("OpenAI response is missing data.b64_json; use a supported GPT image model");
      const bytes = Uint8Array.from(atob(item.b64_json), (char) => char.charCodeAt(0));
      const id = randomId();
      await env.IMAGES_BUCKET.put(`img/${id}.${input.output_format}`, bytes, {
        httpMetadata: { contentType: formats[input.output_format] },
        customMetadata: {
          prompt: input.prompt,
          model: result.model ?? model,
          size: result.size ?? input.size,
          "created-at": new Date().toISOString(),
        },
      });
      let preview = false;
      if (env.IMAGES) {
        try {
          const output = await env.IMAGES.input(new Blob([bytes]).stream())
            .transform({ width: 512, height: 512, fit: "scale-down" })
            .output({ format: "image/jpeg", quality: 75 });
          content.push({ type: "image", mimeType: "image/jpeg", data: base64(new Uint8Array(await output.response().arrayBuffer())) });
          preview = true;
        } catch {
          warnings.push(`Preview unavailable for ${id}; download the image URL instead.`);
        }
      }
      images.push({ id, url: `${origin}/img/${id}`, preview });
    }
    const summary = { images, usage: result.usage ?? null, model: result.model ?? model, ...(warnings.length ? { warnings } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(summary) }, ...content], structuredContent: summary };
  } catch (error) {
    const message = error instanceof z.ZodError
      ? `Invalid input: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`
      : error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export class ImageMcp extends McpAgent<Env, unknown, { userId: string; origin: string }> {
  server = new McpServer({ name: "openai-image-mcp", version: "0.1.0" });
  async init() {
    this.server.registerTool("generate", {
      description: "Generate images from a prompt. Returns public URLs, IDs, token usage, and optional small JPEG previews; never full-size base64.",
      inputSchema: generateSchema,
    }, (input) => runTool("generate", input, this.env, this.props!.origin));
    this.server.registerTool("edit", {
      description: "Edit images using previous result IDs or public https image URLs. An optional PNG mask marks editable areas with transparency.",
      inputSchema: editSchema,
    }, (input) => runTool("edit", input, this.env, this.props!.origin));
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
async function passwordMatches(actual: string, expected: string): Promise<boolean> {
  if (!expected || !actual) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function publicHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/img/")) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Use GET or HEAD", { status: 405, headers: { Allow: "GET, HEAD" } });
    const object = await findImage(env.IMAGES_BUCKET, url.pathname.slice(5));
    if (!object) return new Response("Image not found or expired", { status: 404 });
    const headers = new Headers({
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ETag: object.httpEtag,
    });
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  }
  if (url.pathname !== "/authorize") return new Response("OpenAI Image MCP: connect at /mcp", { status: url.pathname === "/" ? 200 : 404 });
  try {
    const oauth = env.OAUTH_PROVIDER;
    if (request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Cache-Control", "no-store");
      const redirectOrigin = new URL(auth.redirectUri).origin;
      // Some client windows fail to match 'self' (e.g. opaque document origin), so list this Worker's origin explicitly.
      // Form redirects are subject to form-action too; allow only the validated callback's exact origin.
      const formSources = new Set(["'self'", url.origin]);
      if (redirectOrigin !== "null" && !/[;\s*]/.test(redirectOrigin)) formSources.add(redirectOrigin);
      const formAction = [...formSources].join(" ");
      consent.headers.set("Content-Security-Policy", `default-src 'none'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
      return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize Image MCP</title>
<h1>Authorize Image MCP</h1>
<p>Allow ${escapeHtml(details.clientName)} to generate and edit images?</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
<label>Password <input type="password" name="password" required autocomplete="current-password" maxlength="1024"></label>
<button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></form></html>`, { headers: consent.headers });
    }
    if (request.method !== "POST") return new Response("Use GET or POST", { status: 405 });
    if (request.headers.get("Origin") !== url.origin) return new Response("Authorization form must be submitted from this origin; restart sign-in", { status: 403 });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (form.get("decision") !== "approve" || !await passwordMatches(String(form.get("password") ?? ""), env.AUTH_PASSWORD)) {
      return new Response("Incorrect authorization password. Restart sign-in and use the AUTH_PASSWORD configured on this Worker.", { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, userId: "owner", metadata: {}, scope: approved.request.scope,
      props: { userId: "owner", origin: url.origin },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return new Response(`Authorization failed: ${error.message}. Restart sign-in from your MCP client.`, { status: 400 });
    }
    throw error;
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const origin = new URL(request.url).origin;
    return new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch(request, env, ctx) {
          const authContext = ctx as ExecutionContext & { auth: OAuthResourceAuth };
          if (!authContext.auth.scope.includes("images")) return insufficientScope(authContext.auth, ["images"]);
          return ImageMcp.serve("/mcp", { binding: "IMAGE_MCP", transport: "streamable-http" }).fetch(request, env, ctx);
        },
      },
      defaultHandler: { fetch: publicHandler },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["images", "offline_access"],
      requiredScopes: ["images"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    }).fetch(request, env, ctx);
  },
};
