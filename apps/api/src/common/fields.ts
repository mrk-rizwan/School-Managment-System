// Request-field decorators shared by every DTO: one definition of each input rule, so a name, an
// identity number or a phone is normalised and refused the same way on every route.
import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateBy,
  ValidateIf,
  type ValidationArguments,
} from 'class-validator';
import {
  containsIdentityNumber,
  E164_PATTERN,
  IDENTITY_INPUT_PATTERN,
  normaliseIdentityDigits,
  normalisePhone,
} from '@asms/shared';

type Raw = { value: unknown };
type IsEmailOptions = Parameters<typeof IsEmail>[0];

/** No control characters (C0, DEL, C1). */
export const NO_CONTROL = /^[^\p{Cc}]*$/u;
// Whitespace runs that hold no control character; a tab or newline is left for NO_CONTROL to refuse.
const SPACE_RUN = /[^\S\p{Cc}]+/gu;

export const trim = ({ value }: Raw): unknown => (typeof value === 'string' ? value.trim() : value);
export const trimLower = ({ value }: Raw): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
/** Trimmed, every whitespace run collapsed to one space. */
const collapseSpaces = ({ value }: Raw): unknown =>
  typeof value === 'string' ? value.trim().replace(SPACE_RUN, ' ') : value;
/** A valid input becomes its 13 digits; anything else is left for the validator to refuse. */
const toIdentityDigits = ({ value }: Raw): unknown =>
  typeof value === 'string' && IDENTITY_INPUT_PATTERN.test(value)
    ? (normaliseIdentityDigits(value) ?? value)
    : value;
const toE164 = ({ value }: Raw): unknown =>
  typeof value === 'string' ? (normalisePhone(value) ?? value) : value;
/** Query strings `true` / `false` only; anything else stays a string and IsBoolean refuses it. */
const toBoolean = ({ value }: Raw): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

// ------------------------------------------------------------------------------- presence

/** Absent is allowed; present must pass the rest, so `null` is refused rather than skipped. */
export const IfPresent = (): PropertyDecorator =>
  ValidateIf((_object, value) => value !== undefined);

/** Absent and `null` are allowed (null clears); any other value must pass the rest. */
export const IfPresentNotNull = (): PropertyDecorator =>
  ValidateIf((_object, value) => value !== undefined && value !== null);

// ----------------------------------------------------------------------------------- text

/**
 * Free text must not carry an identity number, plain or dashed. The audit tables refuse one
 * (CHECK *_no_id_check), so it is refused here as a 422 rather than reaching them as a 500.
 */
export const NoIdentityNumber = (): PropertyDecorator =>
  ValidateBy({
    name: 'noIdentityNumber',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && !containsIdentityNumber(value),
      defaultMessage: () => '$property must not contain an identity number',
    },
  });

/**
 * A name of `min`-`max` characters: trimmed, whitespace runs collapsed to one space (unless
 * `collapse` is false), no control characters, no identity number.
 */
export const NameField = (
  min: number,
  max: number,
  { collapse = true }: { collapse?: boolean } = {},
): PropertyDecorator =>
  applyDecorators(
    Transform(collapse ? collapseSpaces : trim),
    IsString(),
    Length(min, max),
    Matches(NO_CONTROL, { message: '$property must not contain control characters' }),
    NoIdentityNumber(),
  );

/** Free text (a reason, an address): trimmed, `min`-`max` characters, no identity number. */
export const TextField = (min: number, max: number): PropertyDecorator =>
  applyDecorators(Transform(trim), IsString(), Length(min, max), NoIdentityNumber());

/** `q` on a list: optional, trimmed, 2-`maxLength` characters, no identity number. */
export const SearchField = (description: string, maxLength = 50): PropertyDecorator =>
  applyDecorators(
    ApiPropertyOptional({ minLength: 2, maxLength, description }),
    IsOptional(),
    TextField(2, maxLength),
  );

/** A query-string boolean: the literal strings `true` and `false` only. */
export const QueryBoolean = (
  api: { default?: boolean; description?: string } = {},
): PropertyDecorator =>
  applyDecorators(
    ApiPropertyOptional({ type: Boolean, ...api }),
    IsOptional(),
    Transform(toBoolean),
    IsBoolean(),
  );

// ------------------------------------------------------------------------------- identity

/** A CNIC or B-Form: 13 digits, dashes optional (5-7-1), normalised to the digits. */
export const CnicField = (): PropertyDecorator =>
  applyDecorators(
    Transform(toIdentityDigits),
    IsString(),
    Matches(/^[0-9]{13}$/, { message: '$property must be 13 digits, optionally dashed 5-7-1' }),
  );

/** A phone number, normalised to E.164 (+92 for Pakistani local forms). */
export const PhoneField = (): PropertyDecorator =>
  applyDecorators(
    Transform(toE164),
    IsString(),
    Matches(E164_PATTERN, { message: '$property must be a valid phone number' }),
  );

/**
 * An email address: trimmed and lower-cased, 3-254 characters. `options` go to IsEmail (the
 * platform console accepts a TLD-less host).
 */
export const EmailField = (options?: IsEmailOptions): PropertyDecorator =>
  applyDecorators(Transform(trimLower), IsString(), Length(3, 254), IsEmail(options));

// -------------------------------------------------------------------------------- relations

/** The value must differ from the named sibling property. */
export const DiffersFrom = (property: string): PropertyDecorator =>
  ValidateBy({
    name: 'differsFrom',
    constraints: [property],
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const object: unknown = args?.object;
        const other: unknown =
          typeof object === 'object' && object !== null ? Reflect.get(object, property) : undefined;
        return value !== other;
      },
      defaultMessage: () => `$property must differ from ${property}`,
    },
  });
