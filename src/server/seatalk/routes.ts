// Route-facing wrappers for SeaTalk callbacks (kept separate: verification
// challenge vs decision callbacks, per docs/backend/06-integrations.md).
import type { Backend } from "../backend.ts";
import { seatalkChallengeHandler, seatalkDecisionHandler } from "./callback.ts";

export const approveCallback = (backend: Backend | null, request: Request) =>
  seatalkDecisionHandler(backend, request, "approve");
export const rejectCallback = (backend: Backend | null, request: Request) =>
  seatalkDecisionHandler(backend, request, "reject");
export const challengeCallback = (backend: Backend | null, request: Request) =>
  seatalkChallengeHandler(backend, request);
