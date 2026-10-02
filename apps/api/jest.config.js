/** API tests run end-to-end against the real Postgres in TEST_DATABASE_URL. */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testRegex: '(src|test)/.*\.(spec|e2e-spec)\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 30000,
};
