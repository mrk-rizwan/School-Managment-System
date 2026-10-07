import { ApiProperty } from '@nestjs/swagger';
import { Reason } from './fields';

/**
 * The body of an archive, disable, cancellation or decision that needs a reason (@Reason: 3-500
 * characters, trimmed, no control characters, no identity number). One class, so the OpenAPI
 * document has one ReasonDto schema.
 */
export class ReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
