import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Prisma, StudentDocumentType } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// The tenant table student_documents (contracts/slice-6.md §6.2, R43), append-only. Every read
// takes the caller's Scope (plan §3.4): a document is visible only while its student is, i.e. the
// student has an active enrolment in a scoped section (`all` = every student of the school), the
// one definition in student.repository.ts.

export interface StudentDocumentRecord {
  id: bigint;
  studentId: bigint;
  type: StudentDocumentType;
  /** `{schoolId}/{ULID}.{ext}`: the staged upload's key, never moved. Never leaves the server. */
  objectKey: string;
  mime: string;
  sizeBytes: number;
  uploadedBy: bigint;
  uploadedByName: string | null;
  createdAt: Date;
}

export interface StudentDocumentWrite {
  studentId: bigint;
  type: StudentDocumentType;
  objectKey: string;
  mime: string;
  sizeBytes: number;
  uploadedBy: bigint;
}

const SELECT = {
  id: true,
  studentId: true,
  type: true,
  objectKey: true,
  mime: true,
  sizeBytes: true,
  uploadedBy: true,
  createdAt: true,
  uploadedByUser: {
    select: { staff: { select: { fullName: true } }, guardian: { select: { fullName: true } } },
  },
} satisfies Prisma.StudentDocumentSelect;

type Row = Prisma.StudentDocumentGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ uploadedByUser, ...row }: Row): StudentDocumentRecord => ({
  ...row,
  uploadedByName: uploadedByUser.staff?.fullName ?? uploadedByUser.guardian?.fullName ?? null,
});

/** Newest first, id breaking ties. */
const NEWEST: Prisma.StudentDocumentOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

@Injectable()
export class StudentDocumentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async create(schoolId: SchoolId, data: StudentDocumentWrite): Promise<StudentDocumentRecord> {
    return toRecord(
      await this.txHost.tx.studentDocument.create({ data: { schoolId, ...data }, select: SELECT }),
    );
  }

  async list(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    query: { type?: StudentDocumentType; skip: number; take: number },
  ): Promise<{ rows: StudentDocumentRecord[]; total: number }> {
    const where: Prisma.StudentDocumentWhereInput = {
      schoolId,
      studentId,
      student: { is: studentInScope(scope) },
      ...(query.type === undefined ? {} : { type: query.type }),
    };
    // Sequential, not Promise.all: one connection inside a transaction (§3.3).
    const rows = await this.txHost.tx.studentDocument.findMany({
      where,
      select: SELECT,
      orderBy: NEWEST,
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.studentDocument.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  async findById(
    schoolId: SchoolId,
    scope: Scope,
    id: bigint,
  ): Promise<StudentDocumentRecord | null> {
    const row = await this.txHost.tx.studentDocument.findFirst({
      where: { schoolId, id, student: { is: studentInScope(scope) } },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** The student's photo: the latest `photo` document. */
  async findLatestPhoto(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<StudentDocumentRecord | null> {
    const row = await this.txHost.tx.studentDocument.findFirst({
      where: { schoolId, studentId, type: 'photo', student: { is: studentInScope(scope) } },
      select: SELECT,
      orderBy: NEWEST,
    });
    return row && toRecord(row);
  }

  /** The document holding this object key, if one was committed (a staged upload's replay). */
  async findByObjectKey(
    schoolId: SchoolId,
    objectKey: string,
  ): Promise<StudentDocumentRecord | null> {
    const row = await this.txHost.tx.studentDocument.findFirst({
      where: { schoolId, objectKey },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /** Every document of the student, newest first (the admission result: at most ten). */
  async listAllForStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<StudentDocumentRecord[]> {
    const rows = await this.txHost.tx.studentDocument.findMany({
      where: { schoolId, studentId, student: { is: studentInScope(scope) } },
      select: SELECT,
      orderBy: NEWEST,
    });
    return rows.map(toRecord);
  }
}
