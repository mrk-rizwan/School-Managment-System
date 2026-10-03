// Unit checks for two wave-A fixes: SMTP requires TLS in production only, and the log scrubber
// masks identity numbers split by spaces, `+`, `-` or their URL encodings. Also R92: a failing
// SMTP server costs three attempts and one identity-free log line, never a rejection.
import { createServer, type AddressInfo, type Server } from 'node:net';
import { Logger } from '@nestjs/common';
import { scrubbingStream } from '../../src/common/logging';
import { loadEnv } from '../../src/config/env';
import { Mailer, smtpOptions } from '../../src/modules/auth/mailer';

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

  it('leaves ISO timestamps and short numbers alone; a phone number is masked since slice 9 (R111)', () => {
    const line = '{"time":"2026-10-03T10:11:12.345Z","limit":50,"phone":"+923001234567"}';
    expect(scrub(line)).toBe('{"time":"2026-10-03T10:11:12.345Z","limit":50,"phone":"[phone]"}');
  });
});

describe('Mailer when the SMTP server fails (R92)', () => {
  // An SMTP "server" that accepts each connection and drops it at once: every send fails.
  let server: Server;
  let port: number;
  let connections = 0;

  beforeAll(async () => {
    server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('R92: tries three times, never rejects, and logs one line with no address, token or identity digits', async () => {
    const mailer = new Mailer({ ...loadEnv(), SMTP_HOST: '127.0.0.1', SMTP_PORT: port });
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const token = 'tok_R92_SECRET_abcdefghijklmnopqrstuvwxyz0123';
    const digits = '3520212345671';
    try {
      await expect(
        mailer.send({
          to: 'parent.r92@example.test',
          subject: 'Reset your password',
          text: `https://app.example.test/reset/x#token=${token} for ${digits}`,
        }),
      ).resolves.toBeUndefined();
      expect(connections).toBe(3);
      expect(errors).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain('mail not sent');
      expect(logged).not.toContain('parent.r92@example.test');
      expect(logged).not.toContain(token);
      expect(logged).not.toMatch(/[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/);
    } finally {
      errors.mockRestore();
      mailer.onModuleDestroy();
    }
  }, 15_000);
});
