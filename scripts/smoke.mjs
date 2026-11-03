import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Starts a real local Worker and uses its production OAuth code, never an auth bypass.
// OpenAI is replaced by a local mock server (OPENAI_BASE_URL), so no real API calls are made;
// everything else (Durable Objects, alarms, R2, the MCP transport and uploads) is the real local runtime.
const port = Number(process.env.SMOKE_PORT || 8787);
const origin = `http://localhost:${port}`;
const password = randomBytes(32).toString("base64url");
const stateDir = await mkdtemp(join(tmpdir(), "openai-image-mcp-smoke-"));
const processEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", BROWSER: "none" };

// A valid 16x16 RGBA PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mM4oaHxnxLMMGrAqAGjBgwXAwCpMhcfTAD1DwAAAABJRU5ErkJggg==", "base64");
const openaiCalls = [];
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://mock${req.url}`, { method: req.method, headers: req.headers, body });
  const fields = req.url.endsWith("/edits")
    ? Object.fromEntries([...(await request.formData()).entries()].map(([key, value]) => [key, typeof value === "string" ? value : { name: value.name, size: value.size }]))
    : JSON.parse(body.toString());
  openaiCalls.push({ path: req.url, auth: req.headers.authorization, fields });
  const delay = Number(/slow:(\d+)/.exec(fields.prompt)?.[1] ?? 0);
  await new Promise((resolve) => setTimeout(resolve, delay * 1000));
  res.setHeader("content-type", "application/json");
  if (fields.prompt.includes("fail")) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: { code: "moderation_blocked", message: "Mock rejection for the smoke test.", param: null } }));
  }
  const n = Number(fields.n ?? 1);
  res.end(JSON.stringify({
    created: 0, size: "16x16", quality: "low", background: "opaque", output_format: "png",
    data: Array.from({ length: n }, () => ({ b64_json: PNG.toString("base64") })),
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { image_tokens: 0, text_tokens: 1 } },
  }));
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;

const child = spawn(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js", "dev", "--local", "--ip", "127.0.0.1",
  "--infer-origin-from-routes", "false",
  "--port", String(port), "--inspector-port", "0", "--persist-to", stateDir,
  "--var", `AUTH_PASSWORD:${password}`, "--var", "OPENAI_API_KEY:unused-local-placeholder",
  "--var", `OPENAI_BASE_URL:${mockUrl}`,
  // The production flag set minus global_fetch_strictly_public, which would block the localhost mock.
  "--compatibility-flags", "nodejs_compat",
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
  assert.equal(page.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
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

  const denyPage = await fetch(authUrl);
  assert.equal(denyPage.status, 200);
  assert.equal(denyPage.headers.get("Content-Security-Policy"), page.headers.get("Content-Security-Policy"));
  const denyHandle = (await denyPage.text()).match(/name="handle" value="([^"]+)"/)?.[1];
  assert.ok(denyHandle, "Missing denial consent handle");
  const denyCookie = denyPage.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const denied = await fetch(`${origin}/authorize`, {
    method: "POST", redirect: "manual", headers: { Origin: origin, Cookie: denyCookie },
    body: new URLSearchParams({ handle: denyHandle, decision: "deny" }),
  });
  assert.equal(denied.status, 302);
  const deniedCallback = new URL(denied.headers.get("Location"));
  assert.equal(deniedCallback.origin, new URL(redirectUri).origin);
  assert.equal(deniedCallback.searchParams.get("error"), "access_denied");
  assert.equal(deniedCallback.searchParams.get("state"), state);

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
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["create_upload", "edit", "generate", "get_job"]);
  assert.ok(result.tools.every((tool) => tool.outputSchema), "every tool declares an outputSchema");

  // Fast job: the full result comes back directly.
  const generated = await client.callTool({ name: "generate", arguments: { prompt: "smoke fox", size: "1536x864", quality: "xhigh", n: 2 } });
  assert.equal(generated.isError, undefined, JSON.stringify(generated));
  assert.equal(generated.structuredContent.status, "succeeded");
  assert.equal(generated.structuredContent.images.length, 2);
  const [image] = generated.structuredContent.images;
  assert.deepEqual([image.width, image.height, image.format, image.bytes], [16, 16, "png", PNG.length]);
  assert.deepEqual(openaiCalls.at(-1).fields, { model: "gpt-image-2.5-sunburst", prompt: "smoke fox", size: "1536x864", quality: "xhigh", n: 2 });
  assert.equal(openaiCalls.at(-1).auth, "Bearer unused-local-placeholder");
  const downloaded = await fetch(image.url);
  assert.equal(downloaded.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), PNG);

  // An 8000-character Chinese prompt (~24 KB) reaches OpenAI intact; 9000 characters, which
  // OpenAI would silently ignore, are rejected before any request is made.
  const sentence = "\u4e00\u53ea\u5728\u96ea\u5730\u91cc\u5954\u8dd1\u7684\u7ea2\u72d0\u72f8\uff0c";
  const longPrompt = sentence.repeat(700).slice(0, 8000);
  const long = await client.callTool({ name: "generate", arguments: { prompt: longPrompt } });
  assert.equal(long.structuredContent?.status, "succeeded", JSON.stringify(long).slice(0, 500));
  assert.equal(openaiCalls.at(-1).fields.prompt, longPrompt);
  const callsBefore = openaiCalls.length;
  const tooLong = await client.callTool({ name: "generate", arguments: { prompt: sentence.repeat(700).slice(0, 9000) } });
  assert.ok(tooLong.isError && JSON.stringify(tooLong.content).includes("about 9,000 tokens"), JSON.stringify(tooLong).slice(0, 500));
  assert.equal(openaiCalls.length, callsBefore);

  // Upload a local file with the returned curl-equivalent PUT, then edit it by id.
  const upload = await client.callTool({ name: "create_upload", arguments: {} });
  const [slot] = upload.structuredContent.uploads;
  assert.match(slot.curl, /^curl -sS --fail-with-body -X PUT --data-binary @/);
  const put = await fetch(slot.upload_url, { method: "PUT", body: PNG });
  assert.equal(put.status, 201, await put.clone().text());
  assert.equal((await put.json()).id, slot.id);
  assert.equal((await fetch(slot.upload_url, { method: "PUT", body: PNG })).status, 409);
  const edited = await client.callTool({ name: "edit", arguments: { prompt: "smoke edit", images: [slot.id, image.id], n: 1, input_fidelity: "high" } });
  assert.equal(edited.structuredContent?.status, "succeeded", JSON.stringify(edited));
  const editCall = openaiCalls.at(-1);
  assert.equal(editCall.path, "/v1/images/edits");
  assert.deepEqual(editCall.fields["image[]"], { name: "image-2.png", size: PNG.length });
  assert.equal(editCall.fields.input_fidelity, "high");
  const local = await client.callTool({ name: "edit", arguments: { prompt: "x", images: ["/home/bot/a.png"] } });
  assert.ok(local.isError && JSON.stringify(local.content).includes("create_upload"));

  // Slow job: generate returns a job_id; get_job waits with progress notifications and returns the result.
  const slow = await client.callTool({ name: "generate", arguments: { prompt: "smoke slow:4", wait_seconds: 1 } });
  assert.equal(slow.structuredContent.status, "running", JSON.stringify(slow));
  const progress = [];
  const finished = await client.callTool({ name: "get_job", arguments: { job_id: slow.structuredContent.job_id } }, undefined, {
    onprogress: (event) => progress.push(event), resetTimeoutOnProgress: true,
  });
  assert.equal(finished.structuredContent.status, "succeeded", JSON.stringify(finished));
  assert.ok(progress.length >= 1 && progress[0].message.includes(slow.structuredContent.job_id), JSON.stringify(progress));

  // A job keeps running after its client goes away.
  const detached = await client.callTool({ name: "generate", arguments: { prompt: "smoke slow:2", wait_seconds: 0 } });
  await client.close();
  client = new Client({ name: "local-image-mcp-smoke-2", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
    requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const later = await client.callTool({ name: "get_job", arguments: { job_id: detached.structuredContent.job_id, wait_seconds: 0 } });
  assert.equal(later.structuredContent.status, "succeeded", JSON.stringify(later));

  // Failed job: the OpenAI error text is returned.
  const failed = await client.callTool({ name: "generate", arguments: { prompt: "smoke fail" } });
  assert.ok(failed.isError && JSON.stringify(failed.content).includes("[moderation_blocked]: Mock rejection for the smoke test."), JSON.stringify(failed));

  console.log("PASS: wrangler dev, unauthenticated rejection, password rejection, consent CSP, deny redirect, browser-bound OAuth + PKCE, MCP tools/list (4 tools with output schemas), generate, 8000-character Chinese prompt accepted and 9000 rejected, create_upload + PUT + one-time reuse rejection, edit with upload id, local-path error, async job + get_job with progress, job survives client disconnect, OpenAI error passthrough.");
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
  mock.close();
  await rm(stateDir, { recursive: true, force: true });
}
