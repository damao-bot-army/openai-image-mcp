import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  IMAGE_MCP: DurableObjectNamespace;
  IMAGE_JOBS: DurableObjectNamespace;
  IMAGES_BUCKET: R2Bucket;
  IMAGES?: ImagesBinding;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  OPENAI_API_KEY: string;
  AUTH_PASSWORD: string;
  IMAGE_MODEL?: string;
  OPENAI_BASE_URL?: string;
  UPLOAD_SIGNING_KEY?: string;
}

// Confirmed in openai@7.47.0 resources/images.d.ts.
export const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
