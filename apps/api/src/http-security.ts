import type { NestExpressApplication } from "@nestjs/platform-express";

export function disableFrameworkFingerprint(app: NestExpressApplication): void {
  app.disable("x-powered-by");
}
