// An `any` from the request must not reach a SchoolId. Linted with type information.
import type { Request } from 'express';
import type { SchoolId } from '../../tenancy/school-id';

function findStudents(schoolId: SchoolId): SchoolId {
  return schoolId;
}

export function argument(req: Request): SchoolId {
  return findStudents(req.body.schoolId);
}

export function assignment(req: Request): SchoolId {
  const { schoolId }: { schoolId: SchoolId } = req.body;
  return schoolId;
}

export function returned(req: Request): SchoolId {
  return req.body.schoolId;
}

export function called(req: Request): SchoolId {
  return findStudents(req.body.mint());
}
