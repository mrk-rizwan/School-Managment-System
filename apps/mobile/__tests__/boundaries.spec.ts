// slice-15 §10, §11, §13.1: each lint boundary of eslint.config.cjs fires where it should and is
// silent at its one door. Fixtures are linted as if they lived at a virtual path; the config is
// type-aware, so each is linted against a TypeScript program in which that path holds the text
// (the API's lint-boundaries.spec.ts technique).
import { ESLint, type Linter } from 'eslint';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';

const root = resolve(__dirname, '..');
const posix = (path: string) => path.replace(/\\/g, '/');

const config = ts.getParsedCommandLineOfConfigFile(
  join(root, 'tsconfig.json'),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  },
);
if (!config) throw new Error('tsconfig.json did not parse');

let previous: ts.Program | undefined;

function programWith(virtualPath: string, code: string): ts.Program {
  const base = ts.createCompilerHost(config!.options, true);
  const isVirtual = (file: string) => posix(resolve(file)) === virtualPath;
  const host: ts.CompilerHost = {
    ...base,
    getSourceFile: (file, language, ...rest) =>
      isVirtual(file)
        ? ts.createSourceFile(file, code, language, true)
        : base.getSourceFile(file, language, ...rest),
    fileExists: (file) => isVirtual(file) || base.fileExists(file),
    readFile: (file) => (isVirtual(file) ? code : base.readFile(file)),
  };
  previous = ts.createProgram([virtualPath], config!.options, host, previous);
  return previous;
}

// eslint.config.cjs, passed in rather than looked up: ESLint would import() a config file.
const baseConfig = require('../eslint.config.cjs') as Linter.Config[];

const IMPORT_RULES_OFF = Object.fromEntries(
  baseConfig
    .flatMap((block) => Object.keys(block.rules ?? {}))
    .filter((rule) => rule.startsWith('import/'))
    .map((rule) => [rule, 'off'] as const),
);

const eslintFor = (filePath: string, code: string) =>
  new ESLint({
    cwd: root,
    overrideConfigFile: true,
    baseConfig,
    overrideConfig: {
      languageOptions: {
        parserOptions: { projectService: false, programs: [programWith(filePath, code)] },
      },
      // The import/* rules parse node_modules, which the one-file program does not hold: noise only.
      rules: IMPORT_RULES_OFF,
    },
  });

async function rulesAt(virtualPath: string, code: string): Promise<string[]> {
  const filePath = posix(join(root, virtualPath));
  const [result] = await eslintFor(filePath, code).lintText(code, { filePath });
  if (!result) throw new Error('no lint result');
  const fatal = result.messages.find((m: Linter.LintMessage) => m.fatal);
  if (fatal) throw new Error(fatal.message);
  return result.messages.map((m: Linter.LintMessage) => m.ruleId ?? 'unknown');
}

jest.setTimeout(120_000);

const DOORS: [string, string, string][] = [
  [
    'expo-secure-store',
    "import * as SecureStore from 'expo-secure-store';\nexport const x = SecureStore;\n",
    'src/auth/session-store.ts',
  ],
  [
    'expo-sqlite',
    "import * as SQLite from 'expo-sqlite';\nexport const x = SQLite;\n",
    'src/db/database.ts',
  ],
  [
    'expo-notifications',
    "import * as Notifications from 'expo-notifications';\nexport const x = Notifications;\n",
    'src/push/registration.ts',
  ],
  [
    'openapi-fetch',
    "import createClient from 'openapi-fetch';\nexport const x = createClient;\n",
    'src/api/client.ts',
  ],
  [
    'netinfo',
    "import NetInfo from '@react-native-community/netinfo';\nexport const x = NetInfo;\n",
    'src/net/connectivity.ts',
  ],
  // slice-16 §13.1: one door per native capability added by slice 16.
  [
    'expo-image',
    "import { Image } from 'expo-image';\nexport const x = Image;\n",
    'src/ui/Attachment.tsx',
  ],
  [
    'expo-image-picker',
    "import * as ImagePicker from 'expo-image-picker';\nexport const x = ImagePicker;\n",
    'src/media/picker.ts',
  ],
  [
    'expo-image-manipulator',
    "import { ImageManipulator } from 'expo-image-manipulator';\nexport const x = ImageManipulator;\n",
    'src/media/picker.ts',
  ],
  [
    'expo-file-system',
    "import { File } from 'expo-file-system';\nexport const x = File;\n",
    'src/media/files.ts',
  ],
  [
    'expo-sharing',
    "import { shareAsync } from 'expo-sharing';\nexport const x = shareAsync;\n",
    'src/media/files.ts',
  ],
  [
    'expo-screen-capture',
    "import { preventScreenCaptureAsync } from 'expo-screen-capture';\nexport const x = preventScreenCaptureAsync;\n",
    'src/ui/Screen.tsx',
  ],
];

describe.each(DOORS)('%s has one door', (_name, code, door) => {
  test('refused elsewhere', async () => {
    expect(await rulesAt('src/app/fixture.tsx', code)).toContain('no-restricted-imports');
    expect(await rulesAt('src/outbox/fixture.ts', code)).toContain('no-restricted-imports');
  });

  test('allowed at the door', async () => {
    expect(await rulesAt(door, code)).not.toContain('no-restricted-imports');
  });
});

test('AsyncStorage is refused everywhere, the token store included', async () => {
  const code =
    "import AsyncStorage from '@react-native-async-storage/async-storage';\nexport const x = AsyncStorage;\n";
  expect(await rulesAt('src/app/fixture.tsx', code)).toContain('no-restricted-imports');
  expect(await rulesAt('src/auth/session-store.ts', code)).toContain('no-restricted-imports');
});

test('deep imports of @asms/shared are refused', async () => {
  const code =
    "import { ErrorCode } from '@asms/shared/dist/error-codes';\nexport const x = ErrorCode;\n";
  expect(await rulesAt('src/app/fixture.tsx', code)).toContain('no-restricted-imports');
});

test('console outside log.ts is refused; inside it is the sink', async () => {
  const code = "export function f(): void {\n  console.log('x');\n}\n";
  expect(await rulesAt('src/app/fixture.tsx', code)).toContain('no-console');
  expect(await rulesAt('src/platform/log.ts', code)).not.toContain('no-console');
});

test('a bare fetch outside client.ts is refused, in both spellings', async () => {
  const bare = "export const f = () => fetch('http://x');\n";
  const global = "export const f = () => globalThis.fetch('http://x');\n";
  expect(await rulesAt('src/app/fixture.tsx', bare)).toContain('no-restricted-globals');
  expect(await rulesAt('src/app/fixture.tsx', global)).toContain('no-restricted-properties');
  expect(await rulesAt('src/api/client.ts', bare)).not.toContain('no-restricted-globals');
});

test('refetchInterval is refused (no polling, R160)', async () => {
  const code = 'export const options = { refetchInterval: 5000 };\n';
  expect(await rulesAt('src/app/fixture.tsx', code)).toContain('no-restricted-syntax');
});

test('an inline eslint-disable does not switch a boundary off', async () => {
  const code =
    "// eslint-disable-next-line no-console\nexport function f(): void {\n  console.log('x');\n}\n";
  expect(await rulesAt('src/app/fixture.tsx', code)).toContain('no-console');
});
