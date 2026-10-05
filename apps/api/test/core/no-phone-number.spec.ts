// NoPhoneNumber (R111): notice text that names a phone is refused in every written form, and
// ordinary dates, times, ids and amounts are not mistaken for one (wave G audit M1).
import { validateSync } from 'class-validator';
import { NoPhoneNumber } from '../../src/common/fields';

class Notice {
  @NoPhoneNumber()
  text!: string;
}

const refused = (text: string) => {
  const notice = new Notice();
  notice.text = text;
  return validateSync(notice).length > 0;
};

describe('NoPhoneNumber', () => {
  it.each([
    '03001234567',
    '+923001234567',
    '0300 1234567',
    '+92 300 1234567',
    '0300 123 4567',
    '0300-123-4567',
    '+92 300 123 4567',
    '+92-300-123-4567',
    '92 300 123 4567',
  ])('refuses %s', (phone) => {
    expect(refused(`Call ${phone} after school`)).toBe(true);
  });

  it.each([
    'School reopens on 2026-03-01 at 08:00',
    'Fee of PKR 3,000 is due on the 10th',
    'Term fee Rs. 12500 by 2026-10-10',
    'Bus 303 leaves at 07:30:00',
    'Reference 01K6Z3QWX8M5T0V2B9N4R7C1HD',
  ])('accepts %s', (text) => {
    expect(refused(text)).toBe(false);
  });
});
