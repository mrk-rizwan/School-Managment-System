// OWNER: api-core agent (slice 0.2). Creates and configures the Nest application.
// Kept separate from main.ts so e2e tests and the OpenAPI script build the same app.
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(Number(process.env.API_PORT ?? 3001), '127.0.0.1');
}
