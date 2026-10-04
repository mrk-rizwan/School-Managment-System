// slice-15 §2.2: @asms/shared has no React dependency and never will, so the web's React and the
// app's React may differ by a patch without the shared package caring.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('packages/shared declares no react* dependency of any kind', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../../../packages/shared/package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const names = sections.flatMap((section) =>
    Object.keys((manifest[section] as Record<string, string> | undefined) ?? {}),
  );
  expect(names.filter((name) => /^react($|-|\/)|^@types\/react/.test(name))).toEqual([]);
});
