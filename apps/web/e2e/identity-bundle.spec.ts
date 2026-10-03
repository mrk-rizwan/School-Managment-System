// R16: no identity-number pattern (13 digits standing alone, or #####-#######-#) in the web
// bundle. Reads the production build's client assets (.next/static), which is what a browser
// downloads; run `pnpm --filter @asms/web build` first, as the wave runs do. A missing build
// fails rather than skips, so the check cannot silently stop running.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const STATIC_DIR = join(__dirname, '..', '.next', 'static');
// 13 digits standing as a token of their own (between quotes, spaces or punctuation, so not a
// run inside a minified data table or a longer number), or the dashed CNIC / B-Form form.
const IDENTITY =
  /(?<=^|["'`\s=:(,[])[0-9]{13}(?=$|["'`\s,;)\]}])|(?<![0-9])[0-9]{5}-[0-9]{7}-[0-9](?![0-9])/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('R16: the client bundle holds no identity-number pattern', () => {
  expect(existsSync(STATIC_DIR), 'no production build: run pnpm --filter @asms/web build').toBe(true);
  const assets = files(STATIC_DIR).filter((f) => /\.(js|css|html|json)$/.test(f));
  expect(assets.length).toBeGreaterThan(0);
  const hits = assets.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(IDENTITY)].map((m) => `${file.slice(STATIC_DIR.length + 1)}: ${m[0]}`),
  );
  expect([...new Set(hits)]).toEqual([]);
});
