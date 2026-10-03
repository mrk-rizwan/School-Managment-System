// The pure pieces of the admission flow: the canonical form behind the request hash (R83) and the
// path prefixing of nested refusals.
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../src/common/errors/api-exception';
import { canonicalJson, underPath } from '../../src/modules/people/admissions/admissions.service';

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined members', () => {
    const a = { b: 1, a: { y: [1, { q: true, p: null }], x: 'v' }, c: undefined };
    const b = { a: { x: 'v', y: [1, { p: null, q: true }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"v","y":[1,{"p":null,"q":true}]},"b":1}');
  });

  it('keeps array order and tells values apart', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: '1' })).not.toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });
});

describe('underPath', () => {
  it('moves 422 field paths under the prefix and leaves other errors alone', () => {
    const refusal = new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
      fields: [{ path: 'sectionId', code: ErrorCode.REFERENCE_NOT_FOUND, message: 'x' }],
    });
    const moved = underPath('enrolment', refusal);
    expect(moved).toBeInstanceOf(ApiException);
    expect((moved as ApiException).details).toEqual({
      fields: [{ path: 'enrolment.sectionId', code: ErrorCode.REFERENCE_NOT_FOUND, message: 'x' }],
    });
    const conflict = new ApiException(409, ErrorCode.SECTION_ARCHIVED, 'archived');
    expect(underPath('enrolment', conflict)).toBe(conflict);
  });
});
