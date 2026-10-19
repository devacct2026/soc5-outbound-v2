import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Backend } from "../server/backend.ts";
import { createAppModule } from "./app.module.ts";

/** Build the Nest application. Body parsing is disabled: handlers read the raw body under their own caps. */
export async function createApp(backend: Backend | null): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(createAppModule(backend), { bodyParser: false, logger: ["error", "warn"] });
  app.disable("x-powered-by");
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    next();
  });
  return app;
}

export async function main() {
  const { getBackend } = await import("../server/backend.ts");
  const backend = await getBackend();
  const app = await createApp(backend);
  // Browsers call the Nest API from the Next.js origin only.
  const origin = process.env.SOC5_WEB_ORIGIN;
  if (origin) app.enableCors({ origin, credentials: false, methods: ["GET", "POST", "PUT", "PATCH"], allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-admin-override", "x-override-role"] });
  const port = Number(process.env.SOC5_API_PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  console.log(`SOC5 API listening on :${port} (backend ${backend ? "configured" : "NOT configured: protected routes answer 503"})`);
}
