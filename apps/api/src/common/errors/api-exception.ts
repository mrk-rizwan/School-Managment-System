import { ErrorCode } from '@asms/shared';

/**
 * The one exception application code throws for an expected refusal. It carries its own
 * stable code, so the filter never has to guess one from a status.
 */
export class ApiException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export interface FieldError {
  path: string;
  code: ErrorCode;
  message: string;
}
