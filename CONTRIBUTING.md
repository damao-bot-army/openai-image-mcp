# Contributing

This is a small project. Bug reports and fixes are welcome. For new features or larger changes, open an issue to discuss the idea before writing code.

## Reporting problems

- Bugs: open an issue using the [issue form](https://github.com/damao-bot-army/openai-image-mcp/issues/new/choose).
- Security issues: do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 22.18 or later (24.11 or later on Node 24).

```sh
git clone https://github.com/damao-bot-army/openai-image-mcp.git
cd openai-image-mcp
npm ci
```

None of the checks below need Cloudflare credentials, OpenAI credentials or network access to either service.

## Required checks

Every pull request must pass the same checks that CI runs:

```sh
npm ci
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir dist
```

The dry run uses the committed `wrangler.jsonc`, which contains only placeholder values. For changes to OAuth, uploads or jobs, also run `npm run smoke`; it starts a local Worker against a mock of the OpenAI API (see the README).

## Pull requests

- Open pull requests against `main`.
- Keep each pull request focused on one change, and update the README when behavior or parameters change.
- Your own deployment settings (KV ID, bucket name, custom domain) belong in `wrangler.local.jsonc`, which is ignored by git. Do not commit it, and never put real values in `wrangler.jsonc` or any other tracked file.
