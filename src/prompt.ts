// OpenAI's image endpoints silently drop prompts longer than about 8,192 tokens: the request
// succeeds, input_tokens is ~8 and the image ignores the prompt. Measured with the gpt-image-2.5
// models: 8,000 Chinese characters = 7,490 input tokens; 8,500 = 7,958 (fine); 9,000 and more were
// dropped; 5,000 English characters = 1,050 tokens; 32,000 = ~6,687 tokens.

/** Highest estimate accepted. Pure CJK text at this estimate is about 7,600 real tokens. */
export const PROMPT_TOKEN_LIMIT = 8100;
export const OPENAI_PROMPT_TOKENS = 8192;
/** Text input tokens at or below this, for a prompt of at least IGNORED_MIN_CHARS, mean the prompt was dropped. */
const IGNORED_MAX_TOKENS = 16;
const IGNORED_MIN_CHARS = 200;

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ",");

/** Han, kana, Hangul, CJK punctuation and full-width forms: about one token per character. */
function isCjk(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x3ffff);
}

/**
 * Conservative token estimate without a tokenizer: 1 token per CJK character (measured 0.94) and
 * 1 token per 4 UTF-8 bytes for everything else (measured 4.8 characters per token for English),
 * rounded up per run so short Latin words or numbers inside CJK text count as at least one token.
 */
export function estimatePromptTokens(text: string): number {
  let tokens = 0;
  let runBytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (isCjk(cp)) {
      tokens += 1 + Math.ceil(runBytes / 4);
      runBytes = 0;
    } else {
      runBytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
  }
  return tokens + Math.ceil(runBytes / 4);
}

export function promptTokenProblem(prompt: string): string | undefined {
  const estimate = estimatePromptTokens(prompt);
  if (estimate <= PROMPT_TOKEN_LIMIT) return;
  return `Prompt is too long: about ${thousands(estimate)} tokens (estimated). OpenAI silently ignores prompts over about ` +
    `${thousands(OPENAI_PROMPT_TOKENS)} tokens and returns an unrelated image. Shorten it to about 8,000 tokens: ` +
    "roughly 8,000 Chinese, Japanese or Korean characters, or 32,000 characters of English.";
}

/** A warning when OpenAI's token count shows that a non-trivial prompt was dropped. */
export function ignoredPromptWarning(prompt: string, usage: Record<string, unknown> | null): string | undefined {
  if (!usage) return;
  const details = usage.input_tokens_details as Record<string, unknown> | undefined;
  // Edits count input images in input_tokens, so prefer the text-only count.
  const tokens = typeof details?.text_tokens === "number" ? details.text_tokens
    : typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  if (tokens === undefined || tokens > IGNORED_MAX_TOKENS) return;
  const chars = [...prompt].length;
  if (chars < IGNORED_MIN_CHARS) return;
  return `OpenAI counted only ${tokens} text input tokens for this ${chars}-character prompt, so it most likely ignored the prompt ` +
    `and the image may not match it. OpenAI drops prompts over about ${thousands(OPENAI_PROMPT_TOKENS)} tokens without an error; shorten the prompt and try again.`;
}
