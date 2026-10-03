import { applyDecorators } from '@nestjs/common';
import { ApiDefaultResponse, ApiProperty, ApiResponse } from '@nestjs/swagger';
import { ErrorCode } from '@asms/shared';

class ApiErrorBodyDto {
  @ApiProperty({ enum: Object.values(ErrorCode), enumName: 'ErrorCode' })
  code: ErrorCode;

  @ApiProperty()
  message: string;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  details: Record<string, unknown> | null;

  @ApiProperty()
  requestId: string;
}

/** The one error envelope (§3.9). */
export class ApiErrorDto {
  @ApiProperty({ type: ApiErrorBodyDto })
  error: ApiErrorBodyDto;
}

/** Documents the envelope for the listed statuses and as the default response. Every route carries it. */
export const ApiErrors = (...statuses: number[]): MethodDecorator & ClassDecorator =>
  applyDecorators(
    ...statuses.map((status) => ApiResponse({ status, type: ApiErrorDto })),
    ApiDefaultResponse({ type: ApiErrorDto }),
  );
