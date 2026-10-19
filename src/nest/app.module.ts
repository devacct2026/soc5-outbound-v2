// NestJS HTTP layer. Business rules stay in src/domain and src/server; Nest owns
// transport, lifecycle and DI only. Compiled with tsconfig.nest.json (decorators).
import { All, Controller, Inject, Injectable, Module, Req, Res } from "@nestjs/common";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Backend } from "../server/backend.ts";
import { dispatch } from "../server/routes-table.ts";

export const BACKEND = Symbol("SOC5_BACKEND");
const MAX_BODY = 1_000_000;

/** Express request -> Fetch Request (body buffered under a hard cap; route handlers re-bound it). */
export async function toFetchRequest(req: ExpressRequest): Promise<Request | "TOO_LARGE"> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  let body: Buffer | undefined;
  if (hasBody) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY) return "TOO_LARGE";
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  const url = `http://${req.headers.host ?? "localhost"}${req.originalUrl}`;
  return new Request(url, { method: req.method, headers, body: body && body.length ? new Uint8Array(body) : undefined });
}

@Injectable()
export class DispatchService {
  private readonly backend: Backend | null;
  constructor(@Inject(BACKEND) backend: Backend | null) {
    this.backend = backend;
  }
  handle(request: Request) {
    return dispatch(this.backend, request);
  }
}

@Controller("api/v1")
export class ApiController {
  private readonly svc: DispatchService;
  constructor(@Inject(DispatchService) svc: DispatchService) {
    this.svc = svc;
  }

  @All("*path")
  async any(@Req() req: ExpressRequest, @Res() res: ExpressResponse) {
    const fetchReq = await toFetchRequest(req);
    if (fetchReq === "TOO_LARGE") {
      res.status(413).json({ error: "PAYLOAD_TOO_LARGE" });
      return;
    }
    const out = await this.svc.handle(fetchReq);
    res.status(out.status);
    out.headers.forEach((v, k) => res.setHeader(k, v));
    res.send(Buffer.from(await out.arrayBuffer()));
  }
}

@Controller("health")
export class HealthController {
  @All()
  health() {
    return { ok: true };
  }
}

export function createAppModule(backend: Backend | null) {
  @Module({
    controllers: [ApiController, HealthController],
    providers: [{ provide: BACKEND, useValue: backend }, DispatchService],
  })
  class AppModule {}
  return AppModule;
}
