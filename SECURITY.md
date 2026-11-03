# Security policy

## Why security matters here

A deployment of openai-image-mcp:

- holds an OpenAI API key, and every image request it makes is billed to that key's account;
- exposes an MCP endpoint protected by OAuth, and an upload endpoint protected by signed one-time URLs;
- stores generated and uploaded images in R2, together with records that include the full prompts. Image URLs (`/img/<id>`) are public by design: anyone with the URL can download the image.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to <https://github.com/damao-bot-army/openai-image-mcp/security/advisories/new>. Do not open a public issue for security problems.

Include:

- steps to reproduce;
- the commit or version you tested;
- your configuration with all secrets, keys, IDs and hostnames removed.

You will get an answer within a week. Fixes land on `main`; there are no maintained release branches.

## Scope

In scope:

- bypassing OAuth on `/mcp`, the consent password, or the `images` scope check;
- bypassing upload URL signatures, expiry or one-time use;
- calling OpenAI through a deployment without authorization;
- server-side request forgery through image URLs that the Worker downloads for `edit`;
- leaking `OPENAI_API_KEY`, `AUTH_PASSWORD`, `UPLOAD_SIGNING_KEY` or OAuth tokens;
- open redirects or other flaws in the authorization redirect and consent page;
- reading `meta/` records or job data without authorization.

Out of scope:

- problems in OpenAI, Cloudflare or Grok Bot themselves; report those to the respective vendor;
- deployments that do not follow the README, such as committing secrets, using a weak `AUTH_PASSWORD`, or enabling remote bindings for local development;
- the fact that `/img/<id>` URLs are public and can be fetched by anyone who has them; this is by design;
- OpenAI spending by clients that the owner has authorized.
