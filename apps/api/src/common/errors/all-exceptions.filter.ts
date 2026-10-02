import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Request, Response } from 'express';
import { ApiException } from './api-exception';

// Framework-raised errors get a fixed message per code: their own messages can echo the
// request (a JSON parse error quotes the body, which may hold a CNIC).
const BY_STATUS: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: ErrorCode.MALFORMED_REQUEST, message: 'The request could not be read.' },
  401: { code: ErrorCode.AUTH_REQUIRED, message: 'Sign in to continue.' },
  403: { code: ErrorCode.PERMISSION_DENIED, message: 'You do not have permission to do this.' },
  404: { code: ErrorCode.NOT_FOUND, message: 'Not found.' },
  413: { code: ErrorCode.PAYLOAD_TOO_LARGE, message: 'The request body is too large.' },
  415: {
    code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    message: 'Send the request body as application/json.',
  },
  422: { code: ErrorCode.VALIDATION_FAILED, message: 'Some fields are invalid.' },
  429: { code: ErrorCode.RATE_LIMITED, message: 'Too many requests. Try again shortly.' },
  503: { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'The service is temporarily unavailable.' },
};
const INTERNAL = { status: 500, code: ErrorCode.INTERNAL_ERROR, message: 'Something went wrong.' };

interface Envelope {
  status: number;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown> | null;
}

/** Status of an Express/body-parser error (http-errors), which is not an HttpException. */
function httpErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  if (!('expose' in exception) || !('status' in exception)) return undefined;
  const { status } = exception;
  return typeof status === 'number' ? status : undefined;
}

function toEnvelope(exception: unknown): Envelope {
  if (exception instanceof ApiException) {
    const { status, code, message, details } = exception;
    return { status, code, message, details };
  }
  const status =
    exception instanceof HttpException ? exception.getStatus() : httpErrorStatus(exception);
  const mapped = status === undefined ? undefined : BY_STATUS[status];
  if (status !== undefined && mapped) return { status, ...mapped, details: null };
  return { ...INTERNAL, details: null };
}

/**
 * Bare @Catch(): every error, framework or ours, leaves as the one envelope, so no
 * framework default body (with its message or stack) can reach a client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    const envelope = toEnvelope(exception);
    if (envelope.status >= 500) {
      this.logger.error({ err: exception }, 'request failed');
    }
    if (res.headersSent) return;
    res.status(envelope.status).json({
      error: {
        code: envelope.code,
        message: envelope.message,
        details: envelope.details,
        requestId: typeof req.id === 'string' ? req.id : '',
      },
    });
  }
}
