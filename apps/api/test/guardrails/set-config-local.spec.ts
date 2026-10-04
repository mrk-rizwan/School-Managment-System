// Phase 2 plan §4.6: the history triggers read the acting user and the reason from settings that
// must be TRANSACTION-LOCAL. set_config(name, value, false) would outlive the transaction on the
// pooled connection and be read by whichever request uses it next, attributing that request's
// changes to the wrong person. So every set_config( call in src/ must end with `, true)`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const apiRoot = resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Every `set_config(...)` call in `text`, parentheses balanced, as written. */
function setConfigCalls(text: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(/\bset_config\s*\(/gi)) {
    let depth = 0;
    for (let i = match.index + match[0].length - 1; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) {
        calls.push(text.slice(match.index, i + 1));
        break;
      }
    }
  }
  return calls;
}

const isLocal = (call: string) => /,\s*true\s*\)$/i.test(call);

describe('set_config is always transaction-local', () => {
  it('recognises local and session-level calls', () => {
    const calls = setConfigCalls(
      "SELECT set_config('a', ${x.toString()}, true), set_config('b', $1, false), SET_CONFIG('c', f(g(1)), TRUE)",
    );
    expect(calls).toHaveLength(3);
    expect(calls.map(isLocal)).toEqual([true, false, true]);
  });

  it('every set_config( call in src/ ends with `, true)`', () => {
    const files = sourceFiles(join(apiRoot, 'src'));
    const all = files.flatMap((file) =>
      setConfigCalls(readFileSync(file, 'utf8')).map((call) => ({
        file: relative(apiRoot, file),
        call,
      })),
    );
    // The change-context helper is the one caller today; an empty scan would prove nothing.
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(({ call }) => !isLocal(call))).toEqual([]);
  });
});
