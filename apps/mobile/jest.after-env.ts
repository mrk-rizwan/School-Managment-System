import { configure } from '@testing-library/react-native';

// Screen tests run the real worker, SQLite and client: under a full parallel run a fetch can take
// longer than Testing Library's 1 s default, so async queries wait up to 10 s (a passing query
// still returns at once). A test may take 30 s.
configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(30_000);
