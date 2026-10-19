import type { Actor } from "../domain/requests/workflow.ts";
import type { RequestStore } from "./requests/service.ts";

export interface Backend {
  store: RequestStore;
  /** Validate the bearer token and load the active profile; null if denied. */
  authenticate(request: Request): Promise<Actor | null>;
}

// No Supabase adapter exists yet, so routes answer 503 rather than pretend.
export function getBackend(): Backend | null {
  return null;
}
