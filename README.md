# openai-image-mcp

A small, single-user remote MCP server on Cloudflare Workers. Claude can generate and edit images through the OpenAI Images API. Full-size images stay in R2; tool results contain unguessable public URLs, IDs, token usage, the model used, and optional small JPEG previews.

## Stack and defaults

- TypeScript, `agents` `McpAgent`, MCP Streamable HTTP at `/mcp`.
- `@cloudflare/workers-oauth-provider`: OAuth 2.1, browser-bound consent, PKCE, dynamic client registration, and Client ID Metadata Documents. The owner signs in with `AUTH_PASSWORD`; no external identity provider is required.
- R2 (`IMAGES_BUCKET`), Images (`IMAGES`), a SQLite Durable Object (`IMAGE_MCP`), and OAuth KV (`OAUTH_KV`).
- Default `IMAGE_MODEL`: **`gpt-image-2.5-sunburst`**, confirmed in `openai@7.47.0`'s installed `resources/images.d.ts`. That package also lists the same-generation `gpt-image-2.5-flare`; sunburst is the chosen default. Set `IMAGE_MODEL` in `wrangler.jsonc` to change it. The OpenAI package is a development-only reference; the Worker uses `fetch` directly.
- The current `agents` package additionally imports the optional peer `@modelcontextprotocol/server`. It is explicitly installed for bundling; this `McpAgent` still uses the v1 `@modelcontextprotocol/sdk` server API as required by its installed types and runtime.

## Setup and deployment

Use Node.js 24 or newer and a Cloudflare account with Workers, R2, KV, Durable Objects, and Images transformations enabled.

```sh
npm ci
npx wrangler login
npx wrangler r2 bucket create openai-image-mcp
npx wrangler kv namespace create OAUTH_KV
```

Replace the all-zero **placeholder** KV ID in `wrangler.jsonc` with the ID printed by the last command. Adjust the R2 bucket name if needed. Configure these Worker secrets interactively:

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put AUTH_PASSWORD
```

Use a restricted OpenAI project key with only the necessary image-model/API permissions and a long, randomly generated authorization password. Keep both private; never put real values in `wrangler.jsonc` or committed files.

```sh
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir dist
npm run deploy
```

In **claude.ai → Settings → Connectors → Add custom connector**, paste:

```text
https://openai-image-mcp.<your-workers-subdomain>.workers.dev/mcp
```

Use the actual URL printed by Wrangler (or your Worker custom domain). Complete OAuth in the browser, verify the client's name/domain and redirect destination, enter `AUTH_PASSWORD`, and click **Allow**. The same origin publishes OAuth discovery, `/authorize`, `/oauth/register`, and `/oauth/token`. No separate client secret or third-party login is needed. Requests to `/mcp` without a valid OAuth bearer token receive `401`; the `images` scope is enforced.

## Tools

### `generate`

| Input | Values / default |
| --- | --- |
| `prompt` | Required, nonempty text; at most 1500 UTF-8 bytes |
| `size` | `1024x1024`, `1536x1024`, `1024x1536`, `auto` (default) |
| `quality` | `low`, `medium`, `high`, `auto` (default) |
| `n` | Integer 1–4, default 1 |
| `background` | `transparent`, `opaque`, `auto` (default) |
| `output_format` | `png` (default), `jpeg`, `webp` |

### `edit`

`prompt` and `images` are required. `images` has 1–16 entries, each a previous result's 22-character image ID or a public `https` URL. Optional `mask` takes the same reference format; supply a PNG with transparency marking the area to edit, matching the source dimensions. `size`, `quality`, `background`, and `output_format` are the same as `generate`. There is no `n` parameter for `edit`.

IDs are resolved directly from R2, without downloading through the public endpoint. URLs are downloaded server-side; PNG, JPEG, and WebP are accepted, with a 50 MiB limit per downloaded image, a 30-second fetch timeout, and at most three redirects. Redirect destinations are checked again. HTTP, embedded credentials, localhost, and IP literals are rejected; Workers' `global_fetch_strictly_public` flag also blocks private DNS destinations. The OpenAI request has a 180-second timeout. Additional model-specific input constraints are reported by OpenAI.

A transparent background cannot be combined with JPEG; choose PNG or WebP.

### Results and errors

The first MCP content block is JSON text, also exposed as `structuredContent`:

```json
{
  "images": [
    {
      "id": "aB0123456789cDeF012345",
      "url": "https://openai-image-mcp.example.com/img/aB0123456789cDeF012345",
      "preview": true
    }
  ],
  "usage": { "total_tokens": 42 },
  "model": "gpt-image-2.5-sunburst"
}
```

Each available preview follows as an MCP `image` content block in result order: JPEG, quality 75, long edge at most 512 px, preserving aspect ratio and never upscaling. Full-size base64 is **never** included in results. `preview: false` means no preview was available. If the Images binding is absent, generation/editing still succeeds without previews. If a transformation fails, the stored image remains accessible and the summary includes a warning. No image-processing WASM dependency is used. `usage` is preserved from OpenAI, or `null` if absent; the returned model is the response's model when available, otherwise the requested one.

Input and upstream failures are MCP tool errors (`isError: true`). Errors name invalid fields, include OpenAI HTTP status/code/message/parameter, and name the exact ID or URL that failed to resolve. Expired IDs should be replaced with a current result ID or downloadable URL.

## R2 storage and 30-day expiration

Each object has key `img/{id}.{ext}`, correct HTTP `Content-Type`, and custom metadata `prompt`, `model`, `size`, and `created-at` (ISO 8601). The entire validated prompt is stored. **R2 custom metadata is limited to 2 KiB, so prompts are deliberately capped at 1500 UTF-8 bytes** to leave room for the other fields. Size metadata uses the OpenAI response's size when supplied, otherwise the requested size (possibly `auto`).

To automatically delete images after 30 days:

1. In the Cloudflare dashboard, open **R2 → openai-image-mcp → Settings → Object lifecycle rules**.
2. Add an enabled rule named `expire-generated-images-30-days`.
3. Set its prefix to `img/` and the action to **Delete objects after 30 days**.
4. Save the rule. It also applies to existing matching objects based on their age; lifecycle processing is asynchronous.

`GET /img/:id` (and `HEAD`) is intentionally public and serves only stored image bytes, not custom metadata. Unknown/expired IDs return `404`. IDs use unbiased, cryptographically random 22-character base62 strings (about 131 bits); possession of the URL grants access. Treat URLs as bearer secrets. Responses may be cached for one hour, including after an object is deleted. Do not use this service for images requiring authenticated downloads.

OAuth records live in KV, separate from the image lifecycle. Changing `AUTH_PASSWORD` does not revoke previously issued OAuth tokens; to revoke all grants, use a fresh OAuth KV namespace and redeploy. Consider a Cloudflare rate-limiting rule for `/authorize` to restrict password guessing.

## Local development and MCP Inspector

Local bindings use Wrangler's local emulators; do not enable remote bindings or `--remote` for local tests.

For a manual session, create a gitignored `.dev.vars` with your local-only values:

```dotenv
OPENAI_API_KEY=YOUR_RESTRICTED_OPENAI_KEY
AUTH_PASSWORD=YOUR_LOCAL_AUTHORIZATION_PASSWORD
```

```sh
npm run dev -- --local
# In a second terminal:
npx @modelcontextprotocol/inspector
```

Open the Inspector URL printed in the terminal. Choose **Streamable HTTP**, enter `http://localhost:8787/mcp`, and use the Inspector's OAuth authentication flow. Register/connect, complete the local authorization form, and list tools. Secure browser-bound consent cookies are supported on localhost; use `localhost` consistently. Calling an image tool with a real key incurs a real OpenAI request; merely initializing or listing tools does not.

For an automated, entirely local check without real secrets:

```sh
npm run smoke
```

This starts `wrangler dev --local` with an ephemeral test password and isolated temporary storage, dynamically registers a public OAuth client, exercises wrong-password and unauthenticated rejection, completes browser-bound consent and PKCE, then uses the real MCP SDK client for `initialize` and `tools/list`. It never calls either image service and has no production auth bypass. Port 8787 must be free (`SMOKE_PORT=8790 npm run smoke` selects another port). The script stops Wrangler and removes its temporary storage on exit.

## Verification

```sh
npm ci && npm run typecheck && npm test
npx wrangler deploy --dry-run --outdir /workspace/tmp/forge/oim-dist
npm run smoke
grep -rnIP '[\x{4e00}-\x{9fff}]' --exclude-dir=node_modules --exclude-dir=.git .
```

Vitest mocks OpenAI `fetch`, R2 and Images. It tests validation, output formats, IDs/metadata, preview behavior, usage/model reporting, editing from IDs/URLs/masks, resolution failures, upstream errors, public image serving, and OAuth rejection. Unit tests stub only the Durable Object runtime and the unused `WorkerEntrypoint` base for Node; the smoke test runs the actual Worker, OAuth provider, Durable Object, and MCP transport.
