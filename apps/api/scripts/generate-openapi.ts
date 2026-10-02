// Writes openapi/school.json and openapi/platform.json from the BUILT app (dist/), because
// the @nestjs/swagger CLI plugin that documents DTO properties runs only in `nest build`.
// Run `pnpm build` first. Preview mode instantiates no provider, so no database, Redis or
// secrets are needed.
import 'reflect-metadata';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';

const dist = join(__dirname, '..', 'dist');
const outDir = join(__dirname, '..', 'openapi');

/** Deterministic output: object keys sorted at every level, array order kept. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

async function main(): Promise<void> {
  if (!existsSync(join(dist, 'app.module.js'))) {
    throw new Error('dist/ not found - run `pnpm build` first');
  }
  /* eslint-disable @typescript-eslint/no-require-imports -- loading the build output on purpose */
  const { AppModule } = require(join(dist, 'app.module')) as { AppModule: Type };
  const { API_PREFIX } = require(join(dist, 'common/http')) as { API_PREFIX: string };
  const { buildOpenApiDocuments } = require(join(dist, 'common/openapi')) as {
    buildOpenApiDocuments: (app: INestApplication) => Record<'school' | 'platform', OpenAPIObject>;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  app.setGlobalPrefix(API_PREFIX);
  const documents = buildOpenApiDocuments(app);
  await app.close();

  mkdirSync(outDir, { recursive: true });
  for (const [name, document] of Object.entries(documents)) {
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(sortKeys(document), null, 2)}\n`);
  }
  console.log(`wrote ${Object.keys(documents).map((n) => `openapi/${n}.json`).join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
