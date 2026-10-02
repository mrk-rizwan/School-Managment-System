import { applyDecorators, INestApplication } from '@nestjs/common';
import {
  ApiDefaultResponse,
  ApiProperty,
  ApiResponse,
  DocumentBuilder,
  OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
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

/**
 * School and platform documents, so school and mobile clients carry no platform types.
 * The platform document gains `include: [PlatformModule]` when slice 1 adds it, and the
 * school document then excludes those routes.
 */
export function buildOpenApiDocuments(app: INestApplication): {
  school: OpenAPIObject;
  platform: OpenAPIObject;
} {
  const school = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('ASMS school API').setVersion('1').build(),
  );
  const platform: OpenAPIObject = {
    ...new DocumentBuilder().setTitle('ASMS platform API').setVersion('1').build(),
    paths: {},
  };
  return { school, platform };
}
