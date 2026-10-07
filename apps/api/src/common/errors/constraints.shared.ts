// The refusal builders every constraint → refusal mapping uses (prisma-errors.ts and the
// per-slice constraints-*.ts files). Each returns a thunk: a mapping is called only when its
// constraint fires.
import { ErrorCode } from '@asms/shared';
import { ApiException, fieldRefused } from './api-exception';

/** 422 on one field, INVALID_VALUE. */
export const fieldInvalid = (path: string, message: string) => (): ApiException =>
  fieldRefused(path, ErrorCode.INVALID_VALUE, message);

/** 422: the field holds an identity number (the *_no_id_check CHECKs). */
export const noIdentity = (path: string) => fieldInvalid(path, `${path} must not contain an identity number`);

/** 409 with a stable code and no details. */
export const refusal = (code: ErrorCode, message: string) => (): ApiException => new ApiException(409, code, message);
