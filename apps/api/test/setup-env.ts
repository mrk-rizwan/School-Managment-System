// Loads the repository-root .env for tests and points Prisma at the test database.
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../../.env'), quiet: true });
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
