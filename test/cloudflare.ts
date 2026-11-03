// OAuthProvider uses WorkerEntrypoint only for its optional service-binding API.
export class WorkerEntrypoint {}

// Minimal stand-in for the Durable Object base class; tests supply ctx.storage themselves.
export class DurableObject<Env = unknown> {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
}
