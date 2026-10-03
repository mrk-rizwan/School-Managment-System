// Unit checks for two wave-A fixes: SMTP requires TLS in production only, and the log scrubber
// masks identity numbers split by spaces, `+`, `-` or their URL encodings.
import { scrubbingStream } from '../../src/common/logging';
import { smtpOptions } from '../../src/modules/auth/mailer';

describe('smtpOptions', () => {
  const base = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: 587 };

  it('requires STARTTLS in production', () => {
    expect(smtpOptions({ ...base, NODE_ENV: 'production' })).toMatchObject({ requireTLS: true, secure: false });
  });

  it('does not require TLS in development or test (local Mailpit has none)', () => {
    expect(smtpOptions({ ...base, NODE_ENV: 'development' }).requireTLS).toBe(false);
    expect(smtpOptions({ ...base, NODE_ENV: 'test' }).requireTLS).toBe(false);
  });
});

describe('scrubbingStream', () => {
  const scrub = (line: string) => {
    let out = '';
    scrubbingStream({ write: (s: string) => void (out = s) }).write(line);
    return out;
  };

  it.each([
    ['plain', '3520212345671'],
    ['dashed', '35202-1234567-1'],
    ['spaced', '35202 1234567 1'],
    ['plus', '35202+1234567+1'],
    ['%20', '35202%201234567%201'],
    ['%2B', '35202%2B1234567%2b1'],
    ['%2D', '35202%2D1234567%2D1'],
    ['mixed', '35202 - 1234567+1'],
  ])('masks a %s identity number', (_name, id) => {
    const out = scrub(`{"url":"/api/v1/users?q=${id}&page=1"}`);
    expect(out).toBe('{"url":"/api/v1/users?q=[id]&page=1"}');
  });

  it('leaves ISO timestamps and short numbers alone', () => {
    const line = '{"time":"2026-10-03T10:11:12.345Z","limit":50,"phone":"+923001234567"}';
    expect(scrub(line)).toBe(line);
  });
});
