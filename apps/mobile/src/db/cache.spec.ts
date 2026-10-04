import { resetDevice } from '../test/fake-api';
import { asOf, cacheKey, evictCache, readCache, writeCache } from './cache';

// slice-15 §7.2.

beforeEach(resetDevice);

describe('cacheKey', () => {
  test('params are sorted by name, so their order never makes a second row', () => {
    const a = cacheKey('/api/v1/me/calendar', { dateTo: '2026-10-31', dateFrom: '2026-10-01' });
    const b = cacheKey('/api/v1/me/calendar', { dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    expect(a).toBe('GET /api/v1/me/calendar?dateFrom=2026-10-01&dateTo=2026-10-31');
    expect(b).toBe(a);
  });

  test('no params, and undefined params left out', () => {
    expect(cacheKey('/api/v1/me')).toBe('GET /api/v1/me');
    expect(cacheKey('/api/v1/x', { page: 2, q: undefined })).toBe('GET /api/v1/x?page=2');
  });
});

describe('"as of"', () => {
  const now = new Date('2026-10-04T10:00:00.000Z');

  test('comes from the response Date header', () => {
    expect(asOf('Sun, 04 Oct 2026 04:32:00 GMT', now)).toEqual({
      serverTime: '2026-10-04T04:32:00.000Z',
      serverTimeIsDevice: false,
    });
  });

  test.each([[null], ['not a date']])('falls back to the device clock, flagged (%s)', (header) => {
    expect(asOf(header, now)).toEqual({ serverTime: now.toISOString(), serverTimeIsDevice: true });
  });

  test('is stored and read back with its flag', async () => {
    await writeCache('GET /a', { n: 1 }, 'Sun, 04 Oct 2026 04:32:00 GMT', now);
    await writeCache('GET /b', { n: 2 }, null, now);
    expect(await readCache('GET /a')).toEqual({
      body: { n: 1 },
      serverTime: '2026-10-04T04:32:00.000Z',
      serverTimeIsDevice: false,
    });
    expect(await readCache('GET /b')).toEqual({
      body: { n: 2 },
      serverTime: now.toISOString(),
      serverTimeIsDevice: true,
    });
  });

  test('a second write replaces the row', async () => {
    await writeCache('GET /a', { n: 1 }, null, now);
    await writeCache('GET /a', { n: 2 }, null, now);
    expect((await readCache<{ n: number }>('GET /a'))?.body.n).toBe(2);
  });
});

describe('eviction', () => {
  test('rows fetched more than 30 days ago go; newer ones stay', async () => {
    const now = new Date('2026-10-04T00:00:00.000Z');
    await writeCache('GET /old', 1, null, new Date('2026-09-03T00:00:00.000Z'));
    await writeCache('GET /edge', 2, null, new Date('2026-09-05T00:00:00.000Z'));
    await writeCache('GET /new', 3, null, now);
    expect(await evictCache(now)).toBe(1);
    expect(await readCache('GET /old')).toBeNull();
    expect(await readCache('GET /edge')).not.toBeNull();
    expect(await readCache('GET /new')).not.toBeNull();
  });
});
