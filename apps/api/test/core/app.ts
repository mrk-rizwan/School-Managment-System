import { Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { DestinationStream } from 'pino';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { LOG_DESTINATION } from '../../src/common/logging';

export interface TestAppOptions {
  /** Extra modules, e.g. a test-only controller module. */
  imports?: Type[];
  /** Receives every log line (already scrubbed). Default: discarded. */
  logStream?: DestinationStream;
  /** Providers to replace, e.g. a failing throttler storage. */
  overrides?: { provide: unknown; useValue: unknown }[];
}

/**
 * The real AppModule with the same Express configuration as main (configureApp), so e2e
 * tests exercise the production stack. Call `app.close()` in afterAll.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
  })
    .overrideProvider(LOG_DESTINATION)
    .useValue(options.logStream ?? { write: () => undefined });
  for (const { provide, useValue } of options.overrides ?? []) {
    builder.overrideProvider(provide).useValue(useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app);
  await app.init();
  return app;
}
