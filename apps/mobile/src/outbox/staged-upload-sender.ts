import { ErrorCode } from '@asms/shared';
import { z } from 'zod';
import { currentBearerToken, sendMultipart, sendRaw } from '../api/client';
import {
  clearStagedUpload,
  getUploadFile,
  setStagedUpload,
  uploadTableOf,
  type UploadFile,
  type UploadTable,
} from '../db/local.repository';
import { outboxFileExists, outboxUploadFile } from '../media/files';
import { outcomeOf, thrownOutcome, type SentOutcome } from './outcome';

// The `staged_upload_patch` sender (slice-16 §4.5, §10.1; generalised in Phase 3 §3.9): upload
// the file, then PATCH the item's path with `{ stagedUploadId }`. Every lane with this sender
// keeps its file row in the lane's domainTable (local_attachments for the diary photo,
// local_files for an expense's receipt). Two client-side adjustments, table-tested in
// staged-upload-sender.spec: an upload refused for size or type never heals, so 413/415 become a
// terminal 422 with the server's code; a staged id refused as gone (REFERENCE_NOT_FOUND) is
// retried once with a fresh upload, and a second refusal is terminal. Everything else is the
// machine's ordinary table.

/** Re-upload when the staged id expires within this window. */
export const STAGED_MARGIN_MS = 5 * 60_000;

/** The item's body: the file row's id (named for the diary photo, the first such lane). */
const Body = z.object({ localAttachmentId: z.string().min(1) });
const Staged = z.object({ id: z.string(), expiresAt: z.string() });

const terminal = (code: string, message: string): SentOutcome => ({
  kind: 'response',
  status: 422,
  code,
  message,
  retryAfterSeconds: null,
});

export const FILE_MISSING = terminal(
  'ATTACHMENT_FILE_MISSING',
  'The photo is no longer on this phone',
);

function stagedIsFresh(row: UploadFile, now: Date): boolean {
  return (
    row.stagedUploadId !== null &&
    row.stagedExpiresAt !== null &&
    Date.parse(row.stagedExpiresAt) > now.getTime() + STAGED_MARGIN_MS
  );
}

/** Uploads the file: the staged id, or the outcome that stops this attempt. */
async function upload(table: UploadTable, row: UploadFile): Promise<string | SentOutcome> {
  const sentWith = currentBearerToken();
  let response: Response;
  try {
    response = await sendMultipart('/api/v1/uploads', 'file', outboxUploadFile(row.fileName));
  } catch (error) {
    return thrownOutcome(error);
  }
  const outcome = await outcomeOf(response, sentWith);
  if (outcome.kind !== 'response') return outcome;
  if (outcome.status === 413 || outcome.status === 415) {
    return terminal(outcome.code ?? 'UPLOAD_REFUSED', outcome.message ?? 'The photo was refused');
  }
  if (outcome.status < 200 || outcome.status >= 300) return outcome;
  const staged = Staged.safeParse(outcome.body);
  // A 2xx without a usable id: try again later rather than PATCH with nothing.
  if (!staged.success) return { kind: 'network' };
  await setStagedUpload(row.id, staged.data.id, staged.data.expiresAt, table);
  return staged.data.id;
}

export async function sendStagedUploadPatch(
  item: { path: string; body: string; domainTable: string | null },
  now: Date = new Date(),
): Promise<SentOutcome> {
  const table = uploadTableOf(item.domainTable);
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(JSON.parse(item.body));
  } catch {
    return FILE_MISSING;
  }
  const row = table === null ? null : await getUploadFile(table, parsed.localAttachmentId);
  if (table === null || row === null || !outboxFileExists(row.fileName)) return FILE_MISSING;

  let stagedUploadId = row.stagedUploadId;
  if (!stagedIsFresh(row, now)) {
    const uploaded = await upload(table, row);
    if (typeof uploaded !== 'string') return uploaded;
    stagedUploadId = uploaded;
  }

  const sentWith = currentBearerToken();
  let response: Response;
  try {
    response = await sendRaw('PATCH', item.path, JSON.stringify({ stagedUploadId }));
  } catch (error) {
    return thrownOutcome(error);
  }
  const outcome = await outcomeOf(response, sentWith);
  if (
    outcome.kind === 'response' &&
    outcome.code === ErrorCode.REFERENCE_NOT_FOUND &&
    row.referenceRetries === 0
  ) {
    // The staged upload expired or was consumed meanwhile: upload again, once.
    await clearStagedUpload(row.id, table);
    return { kind: 'network' };
  }
  return outcome;
}
