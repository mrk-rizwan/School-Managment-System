// R62 / CLAUDE.md control 4: every tenant table has an isolation test. The tenant tables are read
// from the migrated database (every table whose school_id is NOT NULL); the isolation tests are
// the test titles, in files that call expectIsolated, whose first word is a table name
// ("staged_uploads", "users: ...", "guardians: ..."). A new tenant table fails here until its
// isolation test exists.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const TEST_ROOT = join(__dirname, '..');

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testFiles(path);
    return /\.(spec|e2e-spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The leading snake_case word of every test that is an isolation test: either its own body calls
 * `expectIsolated`, or it sits in a dedicated isolation suite (a file named `isolation` or
 * `repositories`, where append-only tables are checked by hand). A test elsewhere that merely
 * shares a file with an `expectIsolated` call does not count for its table.
 */
const ISOLATION_SUITE = /[\\/](isolation|repositories|tenant-repositories)\.(spec|e2e-spec)\.ts$/;

function isolationTitles(): Set<string> {
  const covered = new Set<string>();
  for (const file of testFiles(TEST_ROOT)) {
    const text = readFileSync(file, 'utf8');
    const suite = ISOLATION_SUITE.test(file);
    // Each chunk runs from one it()/test() call to the next, so it holds that test's body.
    for (const chunk of text.split(/\b(?=(?:it|test)\(\s*['"`])/)) {
      const title = /^(?:it|test)\(\s*['"`]([a-z][a-z_]*)\b/.exec(chunk);
      if (!title?.[1]) continue;
      if (suite || /\bexpectIsolated\s*[<(]/.test(chunk)) covered.add(title[1]);
    }
  }
  return covered;
}

describe('isolation test coverage (R62)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });

  afterAll(() => db.end());

  it('R62: every tenant table has an isolation test named after it', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'school_id' AND is_nullable = 'NO'
        ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    expect(tables.length).toBeGreaterThan(20);
    const covered = isolationTitles();
    expect(tables.filter((t) => !covered.has(t))).toEqual([]);
  });
});
