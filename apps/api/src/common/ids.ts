import { Injectable, Param, PipeTransform } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { ValidateBy } from 'class-validator';
import { notFound } from './errors/api-exception';

/** A bigint id as it travels in JSON, paths and bodies: positive, no leading zero, ≤ 19 digits. */
export const ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const BIGINT_MAX = 9223372036854775807n;

/** The one id check for paths and bodies: the pattern, and no larger than Postgres int8. */
export function isIdString(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && BigInt(value) <= BIGINT_MAX;
}

/** Path id → bigint. A malformed id is 404, the same as a missing row (§3.9). */
@Injectable()
export class ParseIdPipe implements PipeTransform<unknown, bigint> {
  transform(value: unknown): bigint {
    if (isIdString(value)) return BigInt(value);
    throw notFound();
  }
}

/** `@IdParam() id: bigint` for `:id`. Pair with `@ApiIdParam()` on the method. */
export const IdParam = (name = 'id'): ParameterDecorator => Param(name, ParseIdPipe);

/** Method-level companion: documents the `:name` path id as a pattern-checked string. */
export const ApiIdParam = (name = 'id'): MethodDecorator =>
  ApiParam({ name, schema: { type: 'string', pattern: ID_PATTERN.source } });

/** For an id inside a request body; the service converts with BigInt() after validation. */
export const IsIdString = (): PropertyDecorator =>
  ValidateBy({
    name: 'isIdString',
    validator: { validate: isIdString, defaultMessage: () => '$property must be an id' },
  });
