// Tests never truncate or bulk-delete (plan 0.6): each creates its own schools, so tenancy keeps
// tests apart and they can share one database in parallel. Wiping tables would also break that
// for every other suite running at the same time.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const apiRoot = resolve(__dirname, '../..');
// SQL keywords in upper case or as a statement, so prose such as "never truncate" in a comment passes.
const FORBIDDEN =
  /\bTRUNCATE\b|\btruncate\s+table\b|\.deleteMany\s*\(|\bDELETE\s+FROM\b|\bdelete\s+from\b|\bDROP\s+TABLE\b|\bdrop\s+table\b/;

/**
 * Files that state DELETE / TRUNCATE on purpose: they prove the database refuses them, inside one
 * transaction that is rolled back. Adding a file here is a review decision, not a convenience.
 */
const EXEMPT = new Set([
  join(apiRoot, 'test', 'access', 'history-guards.e2e-spec.ts'),
  // Phase 3 slice 18: the money tables' no-delete, frozen-column and CHECK guards.
  join(apiRoot, 'test', 'fees', 'money-guards.e2e-spec.ts'),
  // Phase 3 wave I: the guards of the slice 19, 23, 24 and 26 tables.
  join(apiRoot, 'test', 'finance-schema', 'money-guards.e2e-spec.ts'),
  // Phase 3 wave J: the guards of the slice 20 and 25 tables.
  join(apiRoot, 'test', 'finance-schema', 'payments-payroll-guards.e2e-spec.ts'),
]);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'generated', 'fixtures'].includes(entry.name) ? [] : testFiles(path);
    return /\.(spec|e2e-spec)\.ts$/.test(entry.name) || dir.includes(join('test', 'support'))
      ? [path]
      : [];
  });
}

describe('tests never truncate', () => {
  it('no test or test-support file truncates, bulk-deletes or drops a table', () => {
    const self = resolve(__filename);
    const offenders = [...testFiles(join(apiRoot, 'src')), ...testFiles(join(apiRoot, 'test'))]
      .filter((file) => file !== self && !EXEMPT.has(file) && FORBIDDEN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(apiRoot, file));
    expect(offenders).toEqual([]);
  });
});
