import { applyDecorators, Type as ClassType } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const MAX_PAGE_SIZE = 50;

export const MAX_PAGE = 999_999;

/**
 * Converts the raw query string only when it is plain decimal digits matching `pattern`.
 * Anything else (`1e300`, `0x10`, ` 5 `, `1.0`, an array from a repeated key) is left as
 * it came, so @IsInt refuses it. Number() alone would accept all of those.
 */
const DecimalQueryInt = (pattern: RegExp): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && pattern.test(value) ? Number(value) : value,
  );

/** page/limit for every list endpoint. Out of range is 422, never clamped (§3.9, R67). */
export class PageQueryDto {
  // Explicit conversion: implicit conversion is off globally, and query values arrive as strings.
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @DecimalQueryInt(/^[1-9][0-9]{0,5}$/)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 })
  @IsOptional()
  @DecimalQueryInt(/^[1-9][0-9]?$/)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = 25;
}

export interface Page<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

/** The list response body. */
export function toPage<T>(data: T[], query: PageQueryDto, total: number): Page<T> {
  return { data, page: query.page, limit: query.limit, total };
}

/** Documents a `Page<Model>` response. */
export const ApiPaginated = (model: ClassType): MethodDecorator =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['data', 'page', 'limit', 'total'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
          total: { type: 'integer', minimum: 0 },
        },
      },
    }),
  );
