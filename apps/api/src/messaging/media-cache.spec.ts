import { MediaCache } from './media-cache';

const bytes = (n: number) => Buffer.alloc(n, 1);

describe('MediaCache (one storage read per attachment per fan-out)', () => {
  it('reads a key once while its entry lives, and again after the time limit', async () => {
    const cache = new MediaCache(1_000, 1_000);
    const load = jest.fn(() => Promise.resolve(bytes(10)));
    for (let i = 0; i < 50; i++) await cache.get('7/A.pdf', load, 0);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('7/A.pdf', load, 999);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('7/A.pdf', load, 1_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('concurrent reads of one key share the read in flight', async () => {
    const cache = new MediaCache();
    let resolve!: (b: Buffer) => void;
    const load = jest.fn(() => new Promise<Buffer>((r) => (resolve = r)));
    const reads = Array.from({ length: 10 }, () => cache.get('7/A.pdf', load, 0));
    resolve(bytes(5));
    expect((await Promise.all(reads)).every((b) => b.length === 5)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed read is not kept: the next asks storage again', async () => {
    const cache = new MediaCache();
    const load = jest.fn().mockRejectedValueOnce(new Error('storage down')).mockResolvedValue(bytes(3));
    await expect(cache.get('7/A.pdf', load, 0)).rejects.toThrow('storage down');
    await expect(cache.get('7/A.pdf', load, 0)).resolves.toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('holds at most its byte cap, dropping the oldest entry first', async () => {
    const cache = new MediaCache(60_000, 25);
    const loads = { a: jest.fn(() => Promise.resolve(bytes(10))), b: jest.fn(() => Promise.resolve(bytes(10))), c: jest.fn(() => Promise.resolve(bytes(10))) };
    await cache.get('7/a.pdf', loads.a, 0);
    await cache.get('7/b.pdf', loads.b, 0);
    await cache.get('7/c.pdf', loads.c, 0);
    expect(cache.size).toBe(20);
    await cache.get('7/b.pdf', loads.b, 0);
    await cache.get('7/c.pdf', loads.c, 0);
    expect([loads.b.mock.calls.length, loads.c.mock.calls.length]).toEqual([1, 1]);
    await cache.get('7/a.pdf', loads.a, 0);
    expect(loads.a).toHaveBeenCalledTimes(2);
    // An object larger than the cap is served but not kept.
    const big = jest.fn(() => Promise.resolve(bytes(30)));
    await cache.get('7/big.pdf', big, 0);
    await cache.get('7/big.pdf', big, 0);
    expect(big).toHaveBeenCalledTimes(2);
    expect(cache.size).toBeLessThanOrEqual(25);
  });
});
