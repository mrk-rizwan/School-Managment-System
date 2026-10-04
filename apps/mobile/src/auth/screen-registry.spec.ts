import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCREEN_REGISTRY } from './screen-registry';
import { TAB_ORDER } from './tabs';

// slice-16 §2: a registered tab always has a screen, and a tab route always has a registry entry.
// The registry equals the (tabs)/<tab> route entries on disk (file or folder) that are tab ids,
// and (tabs)/_layout.tsx's ROUTES lists exactly the registry plus "more".

const tabsDir = join(__dirname, '..', 'app', '(tabs)');

test('the registry equals the tab routes on disk', () => {
  const onDisk = readdirSync(tabsDir)
    .map((entry) => entry.replace(/\.tsx$/, ''))
    .filter((entry) => (TAB_ORDER as readonly string[]).includes(entry));
  expect(onDisk.sort()).toEqual([...SCREEN_REGISTRY].sort());
});

test("the tab layout's ROUTES are the registry plus more", () => {
  const layout = readFileSync(join(tabsDir, '_layout.tsx'), 'utf8');
  const match = /const ROUTES = \[([^\]]*)\]/.exec(layout);
  expect(match).not.toBeNull();
  const routes = [...match![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  expect(routes.sort()).toEqual([...SCREEN_REGISTRY, 'more'].sort());
});

test('every route entry in (tabs) is a tab id, "more" or the layout', () => {
  const extra = readdirSync(tabsDir)
    .map((entry) => entry.replace(/\.tsx$/, ''))
    .filter((entry) => !(TAB_ORDER as readonly string[]).includes(entry))
    .sort();
  expect(extra).toEqual(['_layout', 'more']);
});
