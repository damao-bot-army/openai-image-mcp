import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { type JobRequest, type JobResult, runImageJob, type StoredImage, type Tool } from "./openai";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export interface JobState {
  id: string;
  tool: Tool;
  status: JobStatus;
  summary: string;
  preview: boolean;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  attempts: number;
  partial_images: StoredImage[];
  result?: JobResult;
  error?: string;
}
/** The RPC surface of ImageJob used by the MCP tools. */
export interface JobApi {
  start(request: JobRequest, preview: boolean, summary: string): Promise<JobState>;
  status(): Promise<JobState | null>;
  wait(ms: number): Promise<JobState | null>;
}

export const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Alarm handlers may run for 15 minutes; a job with no result after this was interrupted.
const STALE_MS = 16 * 60 * 1000;
const MAX_ATTEMPTS = 2;

export const isFinished = (state: JobState) => state.status === "succeeded" || state.status === "failed";
export function jobStub(env: Env, jobId: string): JobApi {
  return env.IMAGE_JOBS.getByName(jobId) as unknown as JobApi;
}

/**
 * One Durable Object per job. The work runs in alarm(), so it keeps going after the MCP
 * request that started it returns or disconnects, and the platform retries it if the
 * object is restarted mid-run. State is kept for 30 days, like the images.
 */
export class ImageJob extends DurableObject<Env> implements JobApi {
  private state: JobState | null | undefined;
  private listeners = new Set<() => void>();

  private async load(): Promise<JobState | null> {
    if (this.state === undefined) this.state = (await this.ctx.storage.get<JobState>("state")) ?? null;
    return this.state;
  }

  private async save(state: JobState) {
    this.state = state;
    await this.ctx.storage.put("state", state);
    for (const listener of [...this.listeners]) listener();
  }

  async start(request: JobRequest, preview: boolean, summary: string): Promise<JobState> {
    const existing = await this.load();
    if (existing) return existing;
    const state: JobState = {
      id: request.job_id, tool: request.tool, status: "queued", summary, preview,
      created_at: request.created_at, attempts: 0, partial_images: [],
    };
    await this.ctx.storage.put("request", request);
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now());
    return state;
  }

  async status(): Promise<JobState | null> {
    const state = await this.load();
    if (!state || isFinished(state)) return state;
    if (Date.now() - Date.parse(state.started_at ?? state.created_at) > STALE_MS) {
      return this.finish(state, { error: "The job stopped without a result (the worker restarted or it ran over 15 minutes); start it again" });
    }
    return state;
  }

  /** Resolves when the job state changes or after `ms`, whichever comes first. */
  async wait(ms: number): Promise<JobState | null> {
    const before = await this.status();
    if (!before || isFinished(before) || ms <= 0) return before;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(ms, 60000));
      this.listeners.add(done);
    });
    return this.status();
  }

  private async finish(state: JobState, outcome: { result: JobResult } | { error: string }): Promise<JobState> {
    const next: JobState = { ...state, ...outcome, status: "result" in outcome ? "succeeded" : "failed", finished_at: new Date().toISOString() };
    await this.save(next);
    await this.ctx.storage.setAlarm(Date.now() + JOB_RETENTION_MS);
    return next;
  }

  async alarm() {
    const state = await this.load();
    const request = await this.ctx.storage.get<JobRequest>("request");
    if (!state || !request || isFinished(state)) {
      // The retention period is over (or nothing was ever stored).
      this.state = undefined;
      await this.ctx.storage.deleteAll();
      return;
    }
    if (state.attempts >= MAX_ATTEMPTS) {
      await this.finish(state, { error: `The job was interrupted ${state.attempts} times before OpenAI returned; start it again` });
      return;
    }
    await this.save({ ...state, status: "running", attempts: state.attempts + 1, started_at: new Date().toISOString() });
    try {
      const result = await runImageJob(request, this.env, async (image) => {
        const current = (await this.load())!;
        await this.save({ ...current, partial_images: [...current.partial_images, image] });
      });
      await this.finish((await this.load())!, { result });
    } catch (error) {
      await this.finish((await this.load())!, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
