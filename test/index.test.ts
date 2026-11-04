import { afterEach, describe, expect, it, vi } from "vitest";

// Unit tests isolate the Durable Object transport; scripts/smoke.mjs tests the real one.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() { return { fetch: async () => new Response("MCP transport") }; }
  },
}));

import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import worker, { publicHandler, type Env } from "../src/index";
import { fixture as baseFixture } from "./helpers";

const IMAGE_ID = "aB0123456789cDeF012345";
const fixture = () => baseFixture();
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
afterEach(() => vi.restoreAllMocks());

const BASE_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** Checks the headers every /authorize HTML page shares and that its inline style and script carry the CSP nonce. */
async function htmlPage(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  expect(csp.startsWith(`${BASE_CSP}; `)).toBe(true);
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("form-action");
  const nonce = /style-src 'nonce-([A-Za-z0-9+/=]{24,})'/.exec(csp)?.[1];
  expect(nonce).toBeDefined();
  const html = await response.text();
  expect(html.startsWith("<!doctype html>")).toBe(true);
  const styles = html.match(/<style\b[^>]*>/g) ?? [];
  expect(styles).toEqual([`<style nonce="${nonce}">`]);
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.every((tag) => tag === `<script nonce="${nonce}">`)).toBe(true);
  expect(csp.includes(`script-src 'nonce-${nonce}'`)).toBe(scripts.length > 0);
  // Inline style attributes would be blocked by the CSP, and nothing may be loaded from elsewhere.
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/<[^>]+\s(?:src|srcset)=|<[^>]+\shref="(?!\/authorize\?)|url\((?!#)|@import/);
  return { html, nonce: nonce!, csp };
}

async function registerClient(f: ReturnType<typeof fixture>, clientName: string, redirectUri = "https://client.example/callback") {
  const registration = await worker.fetch(new Request("https://images.example/oauth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName, redirect_uris: [redirectUri],
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
    }),
  }), f.env, ctx);
  expect(registration.status).toBe(201);
  const { client_id } = await registration.json() as { client_id: string };
  const url = new URL("https://images.example/authorize");
  url.search = new URLSearchParams({
    client_id, redirect_uri: redirectUri, response_type: "code", scope: "images", state: "xyz",
    resource: "https://images.example/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256",
  }).toString();
  return url;
}

const postForm = (fields: Record<string, string>, headers: Record<string, string> = {}) => new Request("https://images.example/authorize", {
  method: "POST", headers: { Origin: "https://images.example", ...headers }, body: new URLSearchParams(fields),
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
  it("serves the consent page with an escaped client name, the form, and a nonce-based CSP", async () => {
    const f = fixture();
    const url = await registerClient(f, `<img src=x onerror="alert(1)"> & Bot's`);
    const response = await worker.fetch(new Request(url), f.env, ctx);
    const { html, nonce, csp } = await htmlPage(response, 200);
    expect(csp).toBe(`${BASE_CSP}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-oauth-consent");
    expect(html).toContain("<h1>&#60;img src=x onerror=&#34;alert(1)&#34;&#62; &#38; Bot&#39;s wants to connect</h1>");
    expect(html).toContain("<title>Connect &#60;img src=x onerror=&#34;alert(1)&#34;&#62; &#38; Bot&#39;s · Image MCP</title>");
    expect(html).not.toContain("<img");
    expect(html).toContain('<form method="post" action="/authorize">');
    expect(html).toMatch(/<input type="hidden" name="handle" value="[A-Za-z0-9_-]{43}">/);
    expect(html).toContain('<label for="password">Password</label>');
    expect(html).toContain('<input id="password" type="password" name="password" required autofocus autocomplete="current-password"');
    for (const capability of ["Generate images", "Edit images", "Upload reference images"]) expect(html).toContain(capability);
    // Allow comes first, so pressing Enter in the password field approves rather than denies.
    const allow = html.indexOf('<button class="button primary" name="decision" value="approve">Allow</button>');
    const deny = html.indexOf('<button class="button secondary" name="decision" value="deny" formnovalidate>Deny</button>');
    expect(allow).toBeGreaterThan(0);
    expect(deny).toBeGreaterThan(allow);
    const again = await htmlPage(await worker.fetch(new Request(url), f.env, ctx), 200);
    expect(again.nonce).not.toBe(nonce);
  });

  it("renders a failed authorization as an HTML page with status 400", async () => {
    const f = fixture();
    const response = await worker.fetch(postForm({ handle: "unknown-handle", decision: "deny" }), f.env, ctx);
    const { html } = await htmlPage(response, 400);
    expect(html).toContain("<h1>Authorization failed</h1>");
    expect(html).toContain("This authorization was not started in this browser; start again");
    expect(html).toContain("Return to your MCP client and start the connection again.");
  });

  it("escapes CIMD failure details on the error page", async () => {
    const f = fixture();
    const parseAuthRequest = vi.fn(async () => { throw new CimdFetchError("https://cimd.example/<b>", new Error("bad \"doc\"")); });
    f.env.OAUTH_PROVIDER = { parseAuthRequest } as unknown as Env["OAUTH_PROVIDER"];
    const { html } = await htmlPage(await publicHandler(new Request("https://images.example/authorize?client_id=x"), f.env), 400);
    expect(html).toContain("CIMD fetch failed for https://cimd.example/&#60;b&#62;: bad &#34;doc&#34;");
    expect(html).not.toContain("<b>");
  });

  it("still redirects authorization errors that carry a client redirect", async () => {
    const f = fixture();
    const parseAuthRequest = vi.fn(async () => {
      throw new AuthorizationError("invalid_scope", { description: "Unknown scope", redirectUri: "https://client.example/callback", state: "xyz" });
    });
    f.env.OAUTH_PROVIDER = { parseAuthRequest } as unknown as Env["OAUTH_PROVIDER"];
    const response = await publicHandler(new Request("https://images.example/authorize?client_id=x"), f.env);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://client.example/callback");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });

  it("rejects other methods with an HTML 405 page", async () => {
    const response = await publicHandler(new Request("https://images.example/authorize", { method: "PUT" }), fixture().env);
    const { html } = await htmlPage(response, 405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
    expect(html).toContain("<h1>Method not allowed</h1>");
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
    const response = await publicHandler(postForm({ password: "wrong", decision: "approve", handle: "test-handle" }), f.env);
    const { html } = await htmlPage(response, 403);
    expect(html).toContain("<h1>Incorrect password</h1>");
    // Without a same-origin Referer there is no consent page to go back to.
    expect(html).not.toContain("Try again");
    expect(html).toContain("Return to your MCP client and start the connection again.");
    expect(approveConsent).not.toHaveBeenCalled();
  });
  it("offers a retry link to the consent page a wrong password was posted from", async () => {
    const f = fixture();
    const approveConsent = vi.fn();
    f.env.OAUTH_PROVIDER = { approveConsent } as unknown as Env["OAUTH_PROVIDER"];
    const wrong = (referer: string) => publicHandler(postForm({ password: "wrong", decision: "approve", handle: "h" }, { Referer: referer }), f.env);
    const { html } = await htmlPage(await wrong("https://images.example/authorize?client_id=c1&state=%22%3E%3Cx&scope=images"), 403);
    expect(html).toContain('<a class="button primary" href="/authorize?client_id=c1&#38;state=%22%3E%3Cx&#38;scope=images">Try again</a>');
    for (const referer of ["https://evil.example/authorize?client_id=c1", "https://images.example/other?client_id=c1", "https://images.example/authorize", "not a url"]) {
      expect(await (await wrong(referer)).text()).not.toContain("Try again");
    }
    expect(approveConsent).not.toHaveBeenCalled();
  });
  it("rejects cross-origin authorization form submissions", async () => {
    const f = fixture();
    const approveConsent = vi.fn();
    f.env.OAUTH_PROVIDER = { approveConsent } as unknown as Env["OAUTH_PROVIDER"];
    const response = await publicHandler(postForm({ password: "test-placeholder-password", decision: "approve" }, { Origin: "https://evil.example" }), f.env);
    const { html } = await htmlPage(response, 403);
    expect(html).toContain("<h1>Request blocked</h1>");
    expect(approveConsent).not.toHaveBeenCalled();
  });
});
