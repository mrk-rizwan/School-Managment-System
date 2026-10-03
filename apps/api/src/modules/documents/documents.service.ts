import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, type DocumentType } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException, fieldRefused, notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { SchoolContext, type Actor } from '../../common/school-context';
import {
  ObjectNotFoundError,
  ObjectStorage,
  type StoredObject,
} from '../../common/storage/object-storage';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import {
  StudentDocumentRepository,
  type StudentDocumentRecord,
} from '../../repositories/student-document.repository';
import { StudentRepository } from '../../repositories/student.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { Scope } from '../../tenancy/scope';
import type { AddDocumentDto, ListDocumentsQueryDto, StudentDocumentDto } from './documents.dto';
import { extensionOf, isImageMime } from './upload-processing';

// contracts/slice-6.md §6.2, R41-R43, R91. Every read and write passes the caller's Scope: a
// student outside it is 404, the same as an absent one.

/**
 * R91: expired, already consumed or uploaded by someone else all look the same. `path` is where
 * the id sat in the request body.
 */
export const stagedUploadUnusable = (path: string) =>
  fieldRefused(path, ErrorCode.REFERENCE_NOT_FOUND, 'The upload is unknown, used or expired.');

/** A photo must be an image (also CHECK student_documents_photo_mime_check). */
export const photoNotImage = (path: string) =>
  fieldRefused(path, ErrorCode.INVALID_VALUE, 'A photo must be a JPEG or PNG image.');

export function toDocumentDto(row: StudentDocumentRecord): StudentDocumentDto {
  return {
    id: row.id.toString(),
    studentId: row.studentId.toString(),
    type: row.type,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    uploadedBy: row.uploadedBy.toString(),
    uploadedByName: row.uploadedByName,
    createdAt: row.createdAt,
  };
}

/** A document's content, ready to stream with the headers of §6.2. */
export interface DocumentContent {
  object: StoredObject;
  mime: string;
  sizeBytes: number;
  filename: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger('DocumentsService');

  constructor(
    private readonly context: SchoolContext,
    private readonly documents: StudentDocumentRepository,
    private readonly staged: StagedUploadRepository,
    private readonly students: StudentRepository,
    private readonly audit: AuditLogRepository,
    private readonly storage: ObjectStorage,
  ) {}

  async list(
    session: SchoolSessionContext,
    studentId: bigint,
    query: ListDocumentsQueryDto,
  ): Promise<Page<StudentDocumentDto>> {
    const schoolId = this.context.schoolId;
    const scope = scopeOf(session);
    await this.requireStudent(schoolId, scope, studentId);
    const { rows, total } = await this.documents.list(schoolId, scope, studentId, {
      ...(query.type === undefined ? {} : { type: query.type }),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toDocumentDto), query, total);
  }

  /** 201 with the new document, or 200 with the one this staged upload already became. */
  async add(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: AddDocumentDto,
  ): Promise<{ created: boolean; document: StudentDocumentDto }> {
    const { created, row } = await this.addInTransaction(
      this.context.actor(),
      scopeOf(session),
      studentId,
      BigInt(dto.stagedUploadId),
      dto.type,
    );
    return { created, document: toDocumentDto(row) };
  }

  async content(session: SchoolSessionContext, documentId: bigint): Promise<DocumentContent> {
    const schoolId = this.context.schoolId;
    const row = await this.documents.findById(schoolId, scopeOf(session), documentId);
    if (!row) throw notFound();
    return this.open(schoolId, row);
  }

  /** The student's latest `photo` document; 404 if the student is out of scope or has none. */
  async photo(session: SchoolSessionContext, studentId: bigint): Promise<DocumentContent> {
    const schoolId = this.context.schoolId;
    const row = await this.documents.findLatestPhoto(schoolId, scopeOf(session), studentId);
    if (!row) throw notFound();
    return this.open(schoolId, row);
  }

  /**
   * Consumes the staged upload (one conditional update, R91) and records the document with the
   * same object key: nothing is copied or moved. A second post of a consumed id by its uploader
   * for the same student is the original document (retry-safe).
   */
  @Transactional()
  private async addInTransaction(
    actor: Actor,
    scope: Scope,
    studentId: bigint,
    stagedUploadId: bigint,
    type: DocumentType,
  ): Promise<{ created: boolean; row: StudentDocumentRecord }> {
    const { schoolId, userId } = actor;
    await this.requireStudent(schoolId, scope, studentId);
    const [staged] = await this.staged.findOwned(schoolId, userId, [stagedUploadId]);
    if (!staged) throw stagedUploadUnusable('stagedUploadId');
    if (staged.consumedAt === null) {
      if (type === 'photo' && !isImageMime(staged.mime)) throw photoNotImage('type');
      if (await this.staged.consume(schoolId, userId, staged.id, new Date())) {
        const row = await this.documents.create(schoolId, {
          studentId,
          type,
          objectKey: staged.objectKey,
          mime: staged.mime,
          sizeBytes: staged.sizeBytes,
          uploadedBy: userId,
        });
        await this.audit.record(schoolId, {
          actorUserId: userId,
          action: 'document.added',
          subjectType: 'student_document',
          subjectId: row.id,
          metadata: {
            studentId: studentId.toString(),
            type,
            mime: row.mime,
            sizeBytes: row.sizeBytes,
          },
        });
        return { created: true, row };
      }
    }
    // Consumed (earlier, or by a concurrent request that has now committed) or expired.
    const existing = await this.documents.findByObjectKey(schoolId, staged.objectKey);
    if (existing && existing.studentId === studentId && existing.uploadedBy === userId) {
      return { created: false, row: existing };
    }
    throw stagedUploadUnusable('stagedUploadId');
  }

  private async requireStudent(schoolId: SchoolId, scope: Scope, studentId: bigint): Promise<void> {
    if (!(await this.students.findById(schoolId, scope, studentId))) throw notFound();
  }

  /**
   * The key must sit in the caller's school prefix (also a CHECK on the table); anything else is
   * a fault, refused and logged by id. Access is logged by id, not audited (no GET writes).
   */
  private async open(schoolId: SchoolId, row: StudentDocumentRecord): Promise<DocumentContent> {
    const documentId = row.id.toString();
    if (!row.objectKey.startsWith(`${schoolId}/`)) {
      this.logger.error({ documentId }, 'document object key outside the school prefix');
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    let object: StoredObject;
    try {
      object = await this.storage.get(row.objectKey);
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
      // A committed document whose object is gone: a fault, refused and logged by id only.
      this.logger.error({ documentId }, 'document object missing from storage');
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    this.logger.log({ documentId }, 'document content served');
    return {
      object,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
      filename: `${row.type}-${documentId}.${extensionOf(row.mime)}`,
    };
  }
}
