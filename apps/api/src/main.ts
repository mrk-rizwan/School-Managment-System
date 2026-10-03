import 'reflect-metadata';
import { bootstrap } from './bootstrap';
import { failureLog } from './common/errors/all-exceptions.filter';
import { EnvError } from './config/env';

bootstrap().catch((error: unknown) => {
  // An invalid environment prints which keys are wrong (never their values) and nothing else.
  // Any other failure prints its class and stack, never the raw object: a Prisma or Redis error
  // carries the failing query's arguments as properties.
  console.error(error instanceof EnvError ? error.message : failureLog(error));
  process.exit(1);
});
