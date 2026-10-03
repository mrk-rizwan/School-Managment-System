// R111 (slice 9): the R16 log scrubber also masks phone numbers, and the new redact paths hold.
import { PHONE_NUMBER, scrubbingStream } from '../../src/common/logging';

const scrub = (line: string) => {
  let out = '';
  scrubbingStream({ write: (s: string) => void (out = s) }).write(line);
  return out;
};

describe('R111: phone numbers never reach a log line', () => {
  it.each([
    ['E.164', '+923001234567'],
    ['without plus', '923001234567'],
    ['local', '03001234567'],
    ['URL-encoded', '%2B923001234567'],
  ])('masks a %s mobile', (_name, phone) => {
    const out = scrub(`{"msg":"x","url":"/api/v1/x?phone=${phone}"}`);
    expect(out).not.toContain(phone.replace('%2B', ''));
    expect(out).toContain('[phone]');
  });

  it('leaves ordinary ids, times and counts alone', () => {
    const line = '{"messageId":"9231","time":"2026-10-04T05:00:00.000Z","count":923}';
    expect(scrub(line)).toBe(line);
    expect('12923001234567890'.match(PHONE_NUMBER)).toBeNull();
  });
});
