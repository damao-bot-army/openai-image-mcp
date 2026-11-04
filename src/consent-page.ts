/**
 * Pages served by /authorize: the consent form and its error pages.
 *
 * Every page is one self-contained document with no external fonts, images or scripts, so the CSP
 * stays `default-src 'none'`. The inline stylesheet (and the consent page's small script) run under
 * a random per-response nonce, never 'unsafe-inline'. Inline `style` attributes would be blocked by
 * that policy, so markup uses classes only. Every dynamic value goes through escapeHtml.
 */

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The directives every /authorize page starts from. form-action applies to the whole redirect
 * chain after submit, and OAuth clients may redirect further, so it is deliberately omitted.
 */
export const BASE_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

const ICONS = {
  sparkles: '<path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9-1.9 4.6-1.9-4.6L5.5 10l4.6-1.9z"/><path d="M18.5 15.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"/>',
  pencil: '<path d="M4.5 19.5l.9-3.9L15.6 5.4a2.1 2.1 0 0 1 3 3L8.4 18.6z"/><path d="M13.6 7.4l3 3"/>',
  upload: '<path d="M12 15V4.5"/><path d="M7.5 9L12 4.5 16.5 9"/><path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
  arrows: '<path d="M5 9h14"/><path d="M15.5 5.5L19 9l-3.5 3.5"/><path d="M19 15H5"/><path d="M8.5 11.5L5 15l3.5 3.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3.5 3.5l17 17"/><path d="M10.4 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.8 3.6"/><path d="M6.5 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2"/>',
  alert: '<path d="M10.3 4.4L2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  shield: '<path d="M12 3.5l7 2.7v5.5c0 4.2-2.9 7.6-7 8.8-4.1-1.2-7-4.6-7-8.8V6.2z"/><path d="M12 8.5v4"/><path d="M12 15.5h.01"/>',
  back: '<path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.5 10h10a5 5 0 0 1 0 10H12"/>',
} as const;
type IconName = keyof typeof ICONS;

const icon = (name: IconName, className = "icon") =>
  `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

/** The brand mark: a framed landscape with a sparkle. `id` keeps gradient ids unique per page. */
const logo = (id: string) =>
  `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6a5cff"/><stop offset=".55" stop-color="#d457b4"/><stop offset="1" stop-color="#ff9b4f"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#${id})"/><g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="8.5" width="18" height="15" rx="3.5"/><path d="M7.6 21l4.6-4.4a1.5 1.5 0 0 1 2.1 0l5.6 5.4"/><path d="M17.4 19.4l1.5-1.4a1.5 1.5 0 0 1 2.1 0l3.4 3.2"/></g><path d="M19.8 10.6l.85 2 2 .85-2 .85-.85 2-.85-2-2-.85 2-.85z" fill="#fff"/></svg>`;

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f5f5f8;
  --glow-a: rgba(112, 90, 255, .16);
  --glow-b: rgba(255, 130, 90, .12);
  --surface: #fff;
  --surface-2: #f7f7fa;
  --border: rgba(22, 22, 40, .09);
  --border-strong: rgba(22, 22, 40, .22);
  --text: #15151e;
  --muted: #5b5e6d;
  --accent: #5a45e6;
  --accent-hover: #4b36d6;
  --on-accent: #fff;
  --accent-soft: rgba(90, 69, 230, .09);
  --accent-ink: #4f3dd6;
  --ring: rgba(90, 69, 230, .28);
  --focus: #5a45e6;
  --danger: #c42840;
  --danger-soft: rgba(220, 50, 72, .1);
  --warning: #9a5200;
  --warning-soft: rgba(240, 150, 30, .16);
  --shadow: 0 1px 2px rgba(22, 22, 40, .05), 0 12px 32px -12px rgba(22, 22, 40, .14), 0 32px 80px -32px rgba(70, 50, 170, .24);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0c12;
    --glow-a: rgba(112, 90, 255, .22);
    --glow-b: rgba(255, 130, 90, .08);
    --surface: #16161f;
    --surface-2: #1d1d28;
    --border: rgba(255, 255, 255, .08);
    --border-strong: rgba(255, 255, 255, .2);
    --text: #eeeef4;
    --muted: #a3a5b6;
    --accent: #5f4bf0;
    --accent-hover: #6e5bff;
    --accent-soft: rgba(132, 114, 255, .15);
    --accent-ink: #aea3ff;
    --ring: rgba(132, 114, 255, .32);
    --focus: #8b7cff;
    --danger: #ff7a8f;
    --danger-soft: rgba(255, 100, 125, .14);
    --warning: #ffb85c;
    --warning-soft: rgba(255, 180, 70, .13);
    --shadow: 0 1px 2px rgba(0, 0, 0, .5), 0 32px 80px -32px rgba(0, 0, 0, .8);
  }
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  color: var(--text);
  background:
    radial-gradient(52rem 34rem at 12% -12%, var(--glow-a), transparent 62%),
    radial-gradient(44rem 30rem at 108% 112%, var(--glow-b), transparent 62%),
    var(--bg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.shell { margin: auto; width: 100%; max-width: 456px; padding: 40px 16px; }
.brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 20px; font-weight: 650; font-size: 15px; letter-spacing: -.01em; }
.brand .logo { width: 28px; height: 28px; }
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 22px;
  box-shadow: var(--shadow);
  padding: 32px;
}
.hero, .message { text-align: center; }
.pair { display: flex; align-items: center; justify-content: center; margin-bottom: 22px; }
.avatar { flex: none; width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; }
.avatar.client { background: var(--surface-2); border: 1px solid var(--border); font-size: 24px; font-weight: 650; line-height: 1; }
.avatar .logo { width: 56px; height: 56px; display: block; border-radius: 16px; box-shadow: 0 6px 18px -6px rgba(110, 70, 220, .55); }
.bridge { display: flex; align-items: center; color: var(--muted); }
.bridge::before, .bridge::after { content: ""; width: 20px; border-top: 2px dotted var(--border-strong); }
.bridge .badge { width: 28px; height: 28px; margin: 0 4px; border-radius: 50%; display: grid; place-items: center; background: var(--surface); border: 1px solid var(--border); }
.bridge .icon { width: 15px; height: 15px; }
h1 { margin: 0 0 6px; font-size: 22px; line-height: 1.3; font-weight: 680; letter-spacing: -.02em; overflow-wrap: anywhere; text-wrap: balance; }
.lead { margin: 0; color: var(--muted); text-wrap: pretty; }
code { font: .9em/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 2px 5px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text); white-space: nowrap; }
.section-label { margin: 28px 0 10px; font-size: 12px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
.caps { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--surface-2); }
.caps li { display: flex; align-items: center; gap: 14px; padding: 12px 14px; }
.caps li + li { border-top: 1px solid var(--border); }
.caps .tile { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); }
.caps .icon { width: 18px; height: 18px; }
.caps strong { display: block; font-size: 14.5px; font-weight: 620; line-height: 1.35; }
.caps small { display: block; font-size: 13.5px; color: var(--muted); line-height: 1.4; }
form { margin: 26px 0 0; }
label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 620; }
.field { position: relative; }
.field input {
  width: 100%;
  height: 48px;
  padding: 0 52px 0 14px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 16px;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.field input:hover { border-color: var(--muted); }
.field input:focus { border-color: var(--focus); box-shadow: 0 0 0 4px var(--ring); }
.reveal {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.reveal:hover { background: var(--surface-2); color: var(--text); }
.reveal .icon { width: 20px; height: 20px; }
.reveal .if-revealed, .reveal[aria-pressed="true"] .if-masked { display: none; }
.reveal[aria-pressed="true"] .if-revealed { display: block; }
.hint { margin: 8px 0 0; font-size: 13px; color: var(--muted); }
.actions { display: grid; gap: 10px; margin-top: 24px; }
.button {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 48px;
  padding: 0 20px;
  border: 1px solid transparent;
  border-radius: 12px;
  font: inherit;
  font-size: 15px;
  font-weight: 620;
  text-decoration: none;
  cursor: pointer;
  transition: background-color .15s, border-color .15s, box-shadow .15s;
}
.primary { background: var(--accent); color: var(--on-accent); box-shadow: 0 1px 2px rgba(22, 22, 40, .14), inset 0 1px 0 rgba(255, 255, 255, .16); }
.primary:hover { background: var(--accent-hover); }
.secondary { background: transparent; color: var(--text); border-color: var(--border-strong); }
.secondary:hover { background: var(--surface-2); }
.button:active { transform: translateY(1px); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.field input:focus-visible { outline: none; }
.status { width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 50%; display: grid; place-items: center; }
.status .icon { width: 26px; height: 26px; }
.status.danger { background: var(--danger-soft); color: var(--danger); }
.status.warning { background: var(--warning-soft); color: var(--warning); }
.next { display: flex; align-items: center; gap: 12px; margin: 24px 0 0; padding: 14px 16px; border-radius: 14px; background: var(--accent-soft); text-align: left; font-weight: 560; }
.next .icon { flex: none; width: 20px; height: 20px; color: var(--accent-ink); }
.detail { margin: 16px 0 0; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); text-align: left; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.detail span { display: block; margin-bottom: 2px; font-size: 11.5px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }
@media (max-width: 480px) {
  .shell { padding: 24px 12px; }
  .card { padding: 26px 20px; border-radius: 20px; }
  h1 { font-size: 21px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;

/** Progressive enhancement: reveals the show-password toggle. The form works without it. */
const REVEAL_SCRIPT = `
const input = document.getElementById("password");
const toggle = document.getElementById("reveal");
toggle.hidden = false;
toggle.addEventListener("click", () => {
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  toggle.setAttribute("aria-pressed", String(reveal));
  input.focus();
});
// Submit as a password field so the browser never keeps the value in plain-text form history.
input.form.addEventListener("submit", () => { input.type = "password"; });
`;

function createNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
}

interface PageOptions {
  /** Plain text; escaped here. */
  title: string;
  /** Markup built only from static strings and escaped values. */
  body: string;
  status?: number;
  /** Headers to send with the page, such as the consent binding cookie; updated in place. */
  headers?: Headers;
  /** A static script; it runs under the same nonce as the stylesheet. */
  script?: string;
}

function htmlPage({ title, body, status = 200, headers = new Headers(), script }: PageOptions): Response {
  const nonce = createNonce();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · Image MCP</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
<div class="shell">
<header class="brand">${logo("brand-logo")}<span>Image MCP</span></header>
<main class="card">
${body}
</main>
</div>
${script ? `<script nonce="${nonce}">${script}</script>\n` : ""}</body>
</html>
`;
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", `${BASE_CSP}; style-src 'nonce-${nonce}'${script ? `; script-src 'nonce-${nonce}'` : ""}`);
  // Same-origin form posts carry the consent page URL (used to offer a retry); other origins get nothing.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(html, { status, headers });
}

const CAPABILITIES: [IconName, string, string][] = [
  ["sparkles", "Generate images", "Create new images from a text prompt"],
  ["pencil", "Edit images", "Change, extend or combine existing images"],
  ["upload", "Upload reference images", "Send local images to work from"],
];

export interface ConsentView {
  /** May come from the client; escaped here. */
  clientName: string;
  handle: string;
}

/** The consent form. `headers` are the ones beginConsent() returned; they bind the handle to this browser. */
export function consentPage({ clientName, handle }: ConsentView, headers: Headers): Response {
  const name = escapeHtml(clientName);
  const initial = escapeHtml(Array.from(clientName.trim())[0]?.toUpperCase() ?? "?");
  const capabilities = CAPABILITIES.map(([iconName, title, description]) =>
    `<li><span class="tile">${icon(iconName)}</span><span><strong>${title}</strong><small>${description}</small></span></li>`).join("\n");
  return htmlPage({
    title: `Connect ${clientName}`,
    headers,
    script: REVEAL_SCRIPT,
    body: `<div class="hero">
<div class="pair" aria-hidden="true"><span class="avatar client">${initial}</span><span class="bridge"><span class="badge">${icon("arrows")}</span></span><span class="avatar">${logo("hero-logo")}</span></div>
<h1>${name} wants to connect</h1>
<p class="lead">Allow it to use the image tools on this server?</p>
</div>
<h2 class="section-label" id="capabilities">It will be able to</h2>
<ul class="caps" aria-labelledby="capabilities">
${capabilities}
</ul>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label for="password">Password</label>
<div class="field">
<input id="password" type="password" name="password" required autofocus autocomplete="current-password" autocapitalize="off" spellcheck="false" maxlength="1024" aria-describedby="password-hint">
<button type="button" class="reveal" id="reveal" aria-label="Show password" aria-pressed="false" aria-controls="password" hidden>${icon("eye", "icon if-masked")}${icon("eyeOff", "icon if-revealed")}</button>
</div>
<p class="hint" id="password-hint">The <code>AUTH_PASSWORD</code> set for this server.</p>
<div class="actions">
<button class="button primary" name="decision" value="approve">Allow</button>
<button class="button secondary" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>`,
  });
}

const RESTART = "Return to your MCP client and start the connection again.";

interface MessageView {
  status: number;
  tone: "danger" | "warning";
  icon: IconName;
  /** Plain text. */
  title: string;
  /** Static markup. */
  message: string;
  /** A same-origin link offered instead of the restart hint; escaped here. */
  retryHref?: string;
  next?: string;
  /** Plain text, such as an error message; escaped here. */
  detail?: string;
  headers?: Headers;
}

function messagePage(view: MessageView): Response {
  const action = view.retryHref
    ? `<div class="actions"><a class="button primary" href="${escapeHtml(view.retryHref)}">Try again</a></div>`
    : `<p class="next">${icon("back")}<span>${view.next ?? RESTART}</span></p>`;
  return htmlPage({
    title: view.title,
    status: view.status,
    headers: view.headers,
    body: `<div class="message">
<span class="status ${view.tone}" aria-hidden="true">${icon(view.icon)}</span>
<h1>${escapeHtml(view.title)}</h1>
<p class="lead">${view.message}</p>
${action}
${view.detail ? `<p class="detail"><span>Details</span>${escapeHtml(view.detail)}</p>` : ""}
</div>`,
  });
}

/**
 * The password did not match. `retryHref` is the consent page this form came from: opening it
 * again starts a fresh consent transaction for the same request, exactly like reloading the page.
 */
export function wrongPasswordPage(retryHref?: string): Response {
  return messagePage({
    status: 403, tone: "danger", icon: "lock", title: "Incorrect password", retryHref,
    message: "That doesn't match the <code>AUTH_PASSWORD</code> set for this server, so no access was granted.",
  });
}

export function crossOriginPage(): Response {
  return messagePage({
    status: 403, tone: "danger", icon: "shield", title: "Request blocked",
    message: "Approvals are only accepted from this server's own authorization page. No access was granted.",
  });
}

export function methodNotAllowedPage(): Response {
  return messagePage({
    status: 405, tone: "warning", icon: "alert", title: "Method not allowed",
    message: "This address only accepts GET and POST requests.",
    next: "Start the connection from your MCP client.",
    headers: new Headers({ Allow: "GET, POST" }),
  });
}

/** An AuthorizationError or CimdFetchError without a redirect back to the client. */
export function authorizationFailedPage(reason: string): Response {
  return messagePage({
    status: 400, tone: "warning", icon: "alert", title: "Authorization failed", detail: reason,
    message: "This connection request can't be completed. No access was granted.",
  });
}
