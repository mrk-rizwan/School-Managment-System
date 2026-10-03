// The client key generator must never produce a key the API refuses (idempotency_keys_key_no_id_check):
// a dashless UUID held a 13-digit run about one time in twenty-five, failing admissions at random.
import { newIdempotencyKey } from '@asms/shared';

describe('newIdempotencyKey', () => {
  it('matches the key pattern and never holds 13 consecutive digits (20,000 draws)', () => {
    for (let i = 0; i < 20_000; i++) {
      const key = newIdempotencyKey();
      expect(key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      expect(key).not.toMatch(/[0-9]{13}/);
    }
  });

  it('the dashless form it replaced does produce 13-digit runs (why the dashes stay)', () => {
    let hits = 0;
    for (let i = 0; i < 20_000; i++) {
      if (/[0-9]{13}/.test(newIdempotencyKey().replaceAll('-', ''))) hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });
});
