'use client';

import { unwrap } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import {
  studentsApi,
  type DocumentType,
  type StagedUploadDto,
} from '@/lib/api/school-students-contract';

// Uploads and downloads (contracts/slice-6.md §6.1, §6.2). The API sniffs and re-encodes every
// file; the checks here only spare the office a round trip for an obviously wrong file.

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png'];
export const ACCEPTED_TYPES = [...IMAGE_TYPES, 'application/pdf'];
/** The file input's `accept`. */
export const ACCEPT_ATTRIBUTE = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';

/** Why this file cannot be used for this document type, or null. */
export function fileProblem(file: File, type: DocumentType): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or PDF file.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than 5 MB.';
  if (type === 'photo' && !IMAGE_TYPES.includes(file.type)) return 'A photo must be a JPEG or PNG image.';
  return null;
}

/** POST /uploads, multipart with the one field `file`. The staged id is usable by this user only. */
export function uploadFile(file: File): Promise<StagedUploadDto> {
  const body = new FormData();
  body.append('file', file);
  // The generated body type is { file: string }; openapi-fetch sends FormData as is.
  return unwrap(studentsApi.POST('/api/v1/uploads', { body: body as unknown as { file: string } }));
}

/**
 * GET /documents/:id/content, streamed by the API, saved under the name its
 * Content-Disposition gives. Fetched rather than linked so a refusal is shown, not saved.
 */
export async function downloadDocument(id: string): Promise<void> {
  const { data, error, response } = await studentsApi.GET('/api/v1/documents/{id}/content', {
    params: { path: { id } },
    parseAs: 'blob',
  });
  if (!response.ok || !data) throw toApiError(response, error);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? `document-${id}`;
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
