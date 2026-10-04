// Mobile lint config (slice-15 §11, §13.1). Beyond expo's rules and type-aware typescript-eslint
// it holds the app's boundaries — each native capability has exactly one door:
//   expo-secure-store       → src/auth/session-store.ts   (the token store, §4.3)
//   expo-sqlite             → src/db/database.ts          (§7.1)
//   expo-notifications      → src/push/registration.ts    (§8)
//   openapi-fetch, fetch    → src/api/client.ts           (§2.5)
//   @react-native-community/netinfo → src/net/connectivity.ts (§7.5)
//   expo-image              → src/ui/Attachment.tsx       (slice 16; nothing in 15 renders remote images)
//   console                 → src/platform/log.ts         (§10)
// and bans outright: AsyncStorage (R155), deep imports of @asms/shared, refetchInterval (R160).
// Inline eslint-disable comments have no effect (the API's rule). Each boundary is proven to fire
// by __tests__/boundaries.spec.ts.
// CommonJS so the boundary test can load it without a dynamic import (Jest without vm modules).
const expoConfig = require('eslint-config-expo/flat.js');
const { config: tsConfig, configs: tsConfigs } = require('typescript-eslint');

const DOORS = {
  'expo-secure-store': { file: 'src/auth/session-store.ts', what: 'The token store' },
  'expo-sqlite': { file: 'src/db/database.ts', what: 'The database' },
  'expo-notifications': { file: 'src/push/registration.ts', what: 'Notifications' },
  'openapi-fetch': { file: 'src/api/client.ts', what: 'The API client' },
  '@react-native-community/netinfo': { file: 'src/net/connectivity.ts', what: 'Connectivity' },
  'expo-image': { file: 'src/ui/Attachment.tsx', what: 'Remote images (tap to load, R160)' },
};

const BANNED = [
  {
    name: '@react-native-async-storage/async-storage',
    message: 'AsyncStorage is not used: secrets go to the secure store, data to SQLite (R155).',
  },
];
const BANNED_PATTERNS = [
  { group: ['@asms/shared/*'], message: 'Import from @asms/shared, never a deep path.' },
];

/** The import restriction for a file: every door closed except `open`. */
function restrictImports(open = null) {
  return [
    'error',
    {
      paths: [
        ...BANNED,
        ...Object.entries(DOORS)
          .filter(([name]) => name !== open)
          .map(([name, door]) => ({
            name,
            message: `${door.what} is reached only through ${door.file}.`,
          })),
      ],
      patterns: BANNED_PATTERNS,
    },
  ];
}

const NO_FETCH = {
  'no-restricted-globals': [
    'error',
    {
      name: 'fetch',
      message: 'Requests go through src/api/client.ts (headers, timeouts, 401/426).',
    },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'globalThis', property: 'fetch', message: 'Requests go through src/api/client.ts.' },
    { object: 'window', property: 'fetch', message: 'Requests go through src/api/client.ts.' },
  ],
};

const NO_POLLING = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "Property[key.name='refetchInterval']",
      message: 'No polling (R160): data refreshes on open, on reconnect and on pull.',
    },
  ],
};

module.exports = tsConfig(
  {
    ignores: [
      'dist/**',
      'android/**',
      'ios/**',
      '.expo/**',
      'expo-env.d.ts',
      'src/api/school.d.ts',
    ],
  },
  ...expoConfig,
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tsConfigs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      'no-restricted-imports': restrictImports(),
      'no-console': 'error',
      ...NO_FETCH,
      ...NO_POLLING,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // Promise-returning handlers on Pressable are fine; the void operator marks fire-and-forget.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  // The doors.
  ...Object.entries(DOORS).map(([name, door]) => ({
    files: [door.file],
    rules: { 'no-restricted-imports': restrictImports(name) },
  })),
  {
    files: ['src/api/client.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  { files: ['src/platform/log.ts'], rules: { 'no-console': 'off' } },
  // Config, tests and scripts run in Node.
  {
    files: [
      '*.config.{js,ts,mjs,cjs}',
      'babel.config.js',
      'metro.config.js',
      'jest.config.js',
      'scripts/**',
    ],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
      },
    },
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '__tests__/**', 'jest.setup.ts', 'src/test/**'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Tests load modules in isolation (jest.isolateModules) and read the CommonJS lint config.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      // A probe component hands the session to the test through a module variable.
      'react-hooks/globals': 'off',
    },
  },
  { files: ['**/*.js', '**/*.cjs', '**/*.mjs'], extends: [tsConfigs.disableTypeChecked] },
);
