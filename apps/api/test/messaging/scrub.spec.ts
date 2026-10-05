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

// Slice 17 finding (R16 scan over the worker log): provider error text echoed a phone written with
// spaces or dashes, and the digits-only pattern let it through. The pattern now takes one space or
// dash after the country code and after the 3xx, as the mobile scrubber does.
describe('R16: a spaced or dashed phone in a log line', () => {
  it.each([
    ['local, spaced', '0300 1234567'],
    ['local, dashed', '0300-1234567'],
    ['E.164, spaced', '+92 300 1234567'],
    ['E.164, dashed', '+92-300-1234567'],
    ['without plus, spaced', '92 300 1234567'],
    ['URL-encoded, spaced', '%2B92%20300%201234567'],
  ])('is masked: %s', (_name, phone) => {
    const out = scrub(`{"stack":"Error: provider said ${phone} rejected"}`);
    expect(out).not.toContain(phone);
    expect(out).not.toContain('1234567');
    expect(out).toContain('[phone]');
  });

  it.each([
    ['an ISO timestamp', '{"time":"2026-10-04T05:00:00.000Z"}'],
    ['a date range', '{"msg":"range 2026-03-01 2026-03-31"}'],
    ['a UUID request id', '{"requestId":"0e3a9c1d-0312-4567-8901-234567890123"}'],
    ['a ULID', '{"key":"01K6Z3QWX8M5T0V2B9N4R7C1HD"}'],
    ['ids and counts', '{"schoolId":"92","messageId":"3001234","count":0,"attempt":3}'],
    ['a spaced id list', '{"ids":"92 300 123456 0300 12345678"}'],
    ['a stack line', '{"stack":"at Object.<anonymous> (src/x.ts:92:3)"}'],
  ])('leaves %s alone', (_name, line) => {
    expect(scrub(line)).toBe(line);
  });
});
