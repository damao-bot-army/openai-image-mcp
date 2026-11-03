import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  type OAuthResourceAuth,
  insufficientScope,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { findImage } from "./images";
import { registerTools } from "./tools";
import { handleUpload } from "./upload";

export type { Env } from "./env";
export { ImageJob } from "./jobs";
export { getJobTool, imageTool, jobResult, registerTools, timing } from "./tools";

export class ImageMcp extends McpAgent<Env, unknown, { userId: string; origin: string }> {
  server = new McpServer({ name: "openai-image-mcp", version: "0.2.0" });
  async init() {
    registerTools(this.server, () => this.env, () => this.props!.origin);
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
  if (url.pathname.startsWith("/upload/")) return handleUpload(request, env);
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
      // form-action applies to the whole redirect chain after submit, and OAuth clients may redirect further, so it is omitted here.
      consent.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
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
