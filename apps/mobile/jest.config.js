// Two projects: the app under jest-expo (React Native semantics, native modules mocked by
// jest.setup.ts), and a plain Node project for the checks that run ESLint and read files.
module.exports = {
  projects: [
    {
      displayName: 'app',
      preset: 'jest-expo',
      setupFiles: ['<rootDir>/jest.setup.ts'],
      testMatch: ['<rootDir>/src/**/*.spec.ts?(x)', '<rootDir>/__tests__/scripted-day.spec.ts'],
      transformIgnorePatterns: [
        'node_modules/(?!(\.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|openapi-fetch))',
      ],
    },
    {
      displayName: 'node',
      testEnvironment: 'node',
      testMatch: [
        '<rootDir>/__tests__/boundaries.spec.ts',
        '<rootDir>/__tests__/shared-has-no-react.spec.ts',
      ],
      transform: { '^.+\.tsx?$': ['babel-jest', { presets: ['babel-preset-expo'] }] },
    },
  ],
};
