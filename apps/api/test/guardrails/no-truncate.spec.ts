// Tests never truncate or bulk-delete (plan 0.6): each creates its own schools, so tenancy keeps
// tests apart and they can share one database in parallel. Wiping tables would also break that
// for every other suite running at the same time.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const apiRoot = resolve(__dirname, '../..');
// SQL keywords in upper case or as a statement, so prose such as "never truncate" in a comment passes.
const FORBIDDEN =
  /\bTRUNCATE\b|\btruncate\s+table\b|\.deleteMany\s*\(|\bDELETE\s+FROM\b|\bdelete\s+from\b|\bDROP\s+TABLE\b|\bdrop\s+table\b/;

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
      .filter((file) => file !== self && FORBIDDEN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(apiRoot, file));
    expect(offenders).toEqual([]);
  });
});
