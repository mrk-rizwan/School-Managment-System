// The worker process (Phase 2 plan §2, §3; contracts/slice-9.md §7.12): the same Nest modules as
// the HTTP process, booted as an application context with no HTTP listener. It consumes the
// BullMQ queues and runs every scheduled job, the staged-upload sweep included. Exactly one
// instance runs in production (docs/deployment.md).
//
//   development: pnpm --filter @asms/api worker
//   production:  node dist/worker.js   (pnpm --filter @asms/api start:worker)
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { failureLog } from './common/errors/failure-log';
import { EnvError, loadEnv } from './config/env';

async function bootstrapWorker(): Promise<void> {
  // This entrypoint is what makes a process the worker: modules read it as ENV.WORKER. The only
  // write to process.env in the API; env.ts stays the only reader.
  process.env.WORKER = '1';
  // Validate before Nest starts, so a bad environment fails with only the list of keys.
  loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // SIGTERM / SIGINT close the context, so in-flight jobs can drain.
  app.enableShutdownHooks();
  app.get(Logger).log('worker started', 'Worker');
}

bootstrapWorker().catch((error: unknown) => {
  // As main.ts: the keys of a bad environment, else the error's class and stack, never the object.
  console.error(error instanceof EnvError ? error.message : failureLog(error));
  process.exit(1);
});
