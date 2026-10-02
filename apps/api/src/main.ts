import 'reflect-metadata';
import { bootstrap } from './bootstrap';
import { EnvError } from './config/env';

bootstrap().catch((error: unknown) => {
  // An invalid environment prints which keys are wrong (never their values) and nothing else.
  console.error(error instanceof EnvError ? error.message : error);
  process.exit(1);
});
