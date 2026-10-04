import { ErrorCode } from '@asms/shared';
import { z } from 'zod';
import { currentBearerToken, sendMultipart, sendRaw } from '../api/client';
import {
  clearStagedUpload,
  getAttachment,
  setStagedUpload,
  type LocalAttachment,
} from '../db/local.repository';
import { outboxFileExists, outboxFileUri } from '../media/files';
import { outcomeOf, type SentOutcome } from './outcome';

// The diary_attachment lane's sender (slice-16 §4.5, §10.1): upload the photo, then PATCH the
// entry with the staged id. Two client-side adjustments, table-tested in attachment-sender.spec:
// an upload refused for size or type never heals, so 413/415 become a terminal 422 with the
// server's code; a staged id refused as gone (REFERENCE_NOT_FOUND) is retried once with a fresh
// upload, and a second refusal is terminal. Everything else is the machine's ordinary table.

/** Re-upload when the staged id expires within this window. */
export const STAGED_MARGIN_MS = 5 * 60_000;

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

function stagedIsFresh(row: LocalAttachment, now: Date): boolean {
  return (
    row.stagedUploadId !== null &&
    row.stagedExpiresAt !== null &&
    Date.parse(row.stagedExpiresAt) > now.getTime() + STAGED_MARGIN_MS
  );
}

/** Uploads the file: the staged id, or the outcome that stops this attempt. */
async function upload(row: LocalAttachment): Promise<string | SentOutcome> {
  const sentWith = currentBearerToken();
  let response: Response;
  try {
    response = await sendMultipart('/api/v1/uploads', 'file', {
      uri: outboxFileUri(row.fileName),
      name: row.fileName,
      mime: row.mime,
    });
  } catch {
    return { kind: 'network' };
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
  await setStagedUpload(row.id, staged.data.id, staged.data.expiresAt);
  return staged.data.id;
}

export async function sendAttachment(
  item: { path: string; body: string },
  now: Date = new Date(),
): Promise<SentOutcome> {
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(JSON.parse(item.body));
  } catch {
    return FILE_MISSING;
  }
  const row = await getAttachment(parsed.localAttachmentId);
  if (row === null || !outboxFileExists(row.fileName)) return FILE_MISSING;

  let stagedUploadId = row.stagedUploadId;
  if (!stagedIsFresh(row, now)) {
    const uploaded = await upload(row);
    if (typeof uploaded !== 'string') return uploaded;
    stagedUploadId = uploaded;
  }

  const sentWith = currentBearerToken();
  let response: Response;
  try {
    response = await sendRaw('PATCH', item.path, JSON.stringify({ stagedUploadId }));
  } catch {
    return { kind: 'network' };
  }
  const outcome = await outcomeOf(response, sentWith);
  if (
    outcome.kind === 'response' &&
    outcome.code === ErrorCode.REFERENCE_NOT_FOUND &&
    row.referenceRetries === 0
  ) {
    // The staged upload expired or was consumed meanwhile: upload again, once.
    await clearStagedUpload(row.id);
    return { kind: 'network' };
  }
  return outcome;
}
