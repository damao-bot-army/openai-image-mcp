import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Starts a real local Worker and uses its production OAuth code, never an auth bypass.
// It only initializes MCP and lists tools: it does not call OpenAI or image services.
const port = Number(process.env.SMOKE_PORT || 8787);
const origin = `http://localhost:${port}`;
const password = randomBytes(32).toString("base64url");
const stateDir = await mkdtemp(join(tmpdir(), "openai-image-mcp-smoke-"));
const processEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", BROWSER: "none" };
const child = spawn(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--ip", "127.0.0.1",
  "--port", String(port), "--inspector-port", "0", "--persist-to", stateDir,
  "--var", `AUTH_PASSWORD:${password}`, "--var", "OPENAI_API_KEY:unused-local-placeholder",
], { env: processEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
let logs = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs += chunk.toString().replaceAll(password, "[test-password]"); });
let client;
async function json(response) {
  const text = await response.text();
  assert.ok(response.ok, `HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Wrangler exited: ${child.exitCode}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local server. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Wrangler did not become ready within 60 seconds");
  assert.equal((await fetch(`${origin}/mcp`, { method: "POST" })).status, 401);
  const redirectUri = "http://localhost:9876/callback";
  const registration = await json(await fetch(`${origin}/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Local MCP smoke test", redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }));
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const authUrl = new URL("/authorize", origin);
  authUrl.search = new URLSearchParams({
    client_id: registration.client_id, redirect_uri: redirectUri, response_type: "code",
    scope: "images offline_access", state, resource: `${origin}/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  const page = await fetch(authUrl);
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(handle, "Missing browser-bound consent handle");
  const cookie = page.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const authorize = (candidate) => fetch(`${origin}/authorize`, {
    method: "POST", redirect: "manual", headers: { Origin: origin, Cookie: cookie },
    body: new URLSearchParams({ handle, password: candidate, decision: "approve" }),
  });
  assert.equal((await authorize("wrong-password")).status, 403);
  const approved = await authorize(password);
  assert.equal(approved.status, 302, await approved.clone().text());
  const callback = new URL(approved.headers.get("Location"));
  assert.equal(callback.searchParams.get("state"), state);
  assert.ok(callback.searchParams.get("code"), callback.href);
  const token = await json(await fetch(`${origin}/oauth/token`, {
    method: "POST", body: new URLSearchParams({
      grant_type: "authorization_code", client_id: registration.client_id,
      redirect_uri: redirectUri, code: callback.searchParams.get("code"),
      code_verifier: verifier, resource: `${origin}/mcp`,
    }),
  }));
  assert.ok(token.access_token, "OAuth did not issue an access token");
  client = new Client({ name: "local-image-mcp-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
  }));
  const result = await client.listTools();
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["edit", "generate"]);
  console.log("PASS: wrangler dev, unauthenticated rejection, password rejection, browser-bound OAuth + PKCE, MCP initialize + tools/list (edit, generate).");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await client?.close();
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already stopped. */ }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 5000).unref();
  });
  await rm(stateDir, { recursive: true, force: true });
}
