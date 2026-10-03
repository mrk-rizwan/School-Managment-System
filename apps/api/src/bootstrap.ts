import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import {
  API_PREFIX,
  appVersionFloor,
  originCheck,
  requestIdAndNoStore,
  requireJsonBody,
} from './common/http';
import { buildOpenApiDocuments } from './openapi-documents';
import { captureWebhookRawBody } from './webhooks/raw-body';
import { ENV, type Env, loadEnv, mobileMinAppVersion } from './config/env';

/**
 * Express-level settings that a module cannot express. Shared by main and the e2e tests
 * (test/core/app.ts) so tests exercise the same stack. The app must be created with
 * `bodyParser: false`: the JSON parser is registered here, after the middleware that has
 * to run before it.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));
  // req.ip is the right-most X-Forwarded-For entry. The Next.js rewrite does not add to or
  // overwrite X-Forwarded-For (it forwards the client's header unchanged), so Next is not a
  // counted hop. Production requirement: the edge reverse proxy (nginx/Caddy) in front of
  // Next must OVERWRITE X-Forwarded-For with the client address it saw; with trust proxy = 1
  // req.ip is then the real client IP. In development, without that proxy, a client can
  // spoof the header and so its rate-limit key - acceptable locally only.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Ids are bigint; JSON.stringify throws on bigint. Every response is serialised here.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
  app.setGlobalPrefix(API_PREFIX);
  app.use(requestIdAndNoStore);
  // contracts/slice-9.md §1.2: the app-version floor, then the Origin check, both before any
  // guard (so before the per-IP throttle and session resolution).
  app.use(appVersionFloor(mobileMinAppVersion(app.get<Env>(ENV))));
  app.use(originCheck(app.get<Env>(ENV).APP_URL));
  app.use(requireJsonBody);
  // JSON only (no urlencoded parser), 100 kB; larger bodies are 413. Webhook paths keep their raw
  // bytes for the HMAC check (R172, contracts/slice-9.md §8.1).
  // Nest passes the options to express.json unchanged; its type omits `verify`, hence the variable.
  const jsonOptions = { limit: '100kb', verify: captureWebhookRawBody };
  app.useBodyParser('json', jsonOptions);
}

export async function bootstrap(): Promise<void> {
  // Validate before Nest starts, so a bad environment fails with only the list of keys.
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app);
  if (env.NODE_ENV === 'development') {
    SwaggerModule.setup('api/docs', app, buildOpenApiDocuments(app).school);
  }
  // Loopback only: the web app's same-origin proxy is the one way in.
  await app.listen(env.API_PORT, '127.0.0.1');
}
