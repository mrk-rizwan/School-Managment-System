import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { ApiException, FieldError } from './errors/api-exception';

// class-validator's constraint key for a property the DTO does not declare.
const UNKNOWN_PROPERTY = 'whitelistValidation';

/** Flattens nested errors to `guardians[0].phone`-style paths. */
function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const path = /^\d+$/.test(error.property)
      ? `${parent}[${error.property}]`
      : parent
        ? `${parent}.${error.property}`
        : error.property;
    const own = Object.entries(error.constraints ?? {}).map(([constraint, message]) => ({
      path,
      code: constraint === UNKNOWN_PROPERTY ? ErrorCode.UNKNOWN_FIELD : ErrorCode.INVALID_VALUE,
      message,
    }));
    return [...own, ...flatten(error.children ?? [], path)];
  });
}

/** §3.9: shape errors are 422 with per-field codes; unknown fields (including schoolId) are refused. */
export const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  // Off: implicit conversion turns "abc" into NaN and "false" into true silently.
  transformOptions: { enableImplicitConversion: false },
  // By default the error echoes the submitted object - CNIC and password included.
  validationError: { target: false, value: false },
  exceptionFactory: (errors) =>
    new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
      fields: flatten(errors),
    }),
});

/**
 * For handlers that take no query parameters. Declaring it makes the ValidationPipe refuse
 * any unknown parameter (§3.9: every handler declares a query DTO, even an empty one).
 */
export class NoQueryDto {}
