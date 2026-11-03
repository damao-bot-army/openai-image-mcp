import { afterEach, describe, expect, it, vi } from "vitest";

// Unit tests isolate the Durable Object transport; scripts/smoke.mjs tests the real one.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() { return { fetch: async () => new Response("MCP transport") }; }
  },
}));

import worker, { publicHandler, type Env } from "../src/index";
import { fixture as baseFixture } from "./helpers";

const IMAGE_ID = "aB0123456789cDeF012345";
const fixture = () => baseFixture();
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
afterEach(() => vi.restoreAllMocks());

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
  it("serves the consent page with a CSP that omits form-action", async () => {
    const f = fixture();
    const redirectUri = "https://client.example/callback";
    const registration = await worker.fetch(new Request("https://images.example/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Consent CSP test", redirect_uris: [redirectUri],
        grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
      }),
    }), f.env, ctx);
    expect(registration.status).toBe(201);
    const { client_id } = await registration.json() as { client_id: string };
    const url = new URL("https://images.example/authorize");
    url.search = new URLSearchParams({
      client_id, redirect_uri: redirectUri, response_type: "code", scope: "images",
      resource: "https://images.example/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256",
    }).toString();
    const response = await worker.fetch(new Request(url), f.env, ctx);
    expect(response.status).toBe(200);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("form-action");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

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
