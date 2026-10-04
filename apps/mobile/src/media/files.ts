import { newIdempotencyKey } from '@asms/shared';
import { Directory, File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import { authHeaders } from '../api/client';
import { apiUrl } from '../platform/config';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';

// The only importer of expo-file-system and expo-sharing (lint, slice-16 §13.1). Photos waiting
// to be sent live in <document>/outbox/ (private to the app, excluded from backup), named by
// their attachment id; nothing is ever written to the camera roll. Downloads go to the cache
// directory as asms-<random>.<ext> and are deleted after use (§13.3).

const OUTBOX_FOLDER = 'outbox';
const DOWNLOAD_PREFIX = 'asms-';

function outboxDirectory(): Directory {
  return new Directory(Paths.document, OUTBOX_FOLDER);
}

function outboxFile(name: string): File {
  return new File(outboxDirectory(), name);
}

/** The file:// URI of a waiting photo, for the multipart upload. */
export function outboxFileUri(name: string): string {
  return outboxFile(name).uri;
}

export function outboxFileExists(name: string): boolean {
  return outboxFile(name).exists;
}

/**
 * Moves a picked (and already downscaled) photo into the outbox folder as `<id>.jpg` and deletes
 * the picker's copy. Returns the stored name and size.
 */
export function storePickedPhoto(
  sourceUri: string,
  attachmentId: string,
): { fileName: string; sizeBytes: number } {
  const directory = outboxDirectory();
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  const fileName = `${attachmentId}.jpg`;
  const source = new File(sourceUri);
  const target = new File(directory, fileName);
  source.copySync(target);
  deleteQuietly(source);
  return { fileName, sizeBytes: target.size };
}

function deleteQuietly(file: File | Directory): void {
  try {
    if (file.exists) file.delete();
  } catch (error) {
    log('warn', 'files.delete_failed', errorFields(error));
  }
}

/** The picker's own copy of a photo, once the downscaled one is stored (cache directory only). */
export function deleteTemporaryFile(uri: string): void {
  if (uri.startsWith(Paths.cache.uri)) deleteQuietly(new File(uri));
}

/** Deletes one waiting photo's file (done, discarded). */
export function deleteOutboxFile(name: string): void {
  deleteQuietly(outboxFile(name));
}

/** Deletes every outbox file not named in `keep` (the sweep after a discard or a session loss). */
export function deleteOutboxFilesExcept(keep: readonly string[]): void {
  const directory = outboxDirectory();
  if (!directory.exists) return;
  const kept = new Set(keep);
  for (const entry of directory.list()) {
    if (entry instanceof File && !kept.has(entry.name)) deleteQuietly(entry);
  }
}

/** The wipe: the whole outbox folder (slice-16 §13.3). */
export function deleteOutboxDirectory(): void {
  deleteQuietly(outboxDirectory());
}

/** Startup, defensively: any download a crash left in the cache directory. */
export function deleteCachedDownloads(): void {
  const cache = Paths.cache;
  if (!cache.exists) return;
  for (const entry of cache.list()) {
    if (entry instanceof File && entry.name.startsWith(DOWNLOAD_PREFIX)) deleteQuietly(entry);
  }
}

/**
 * Downloads an API path to the cache directory with the bearer in a header (never the URL).
 * Returns the file's URI; the caller deletes it with deleteDownload.
 */
export async function downloadToCache(path: string, extension: string): Promise<string> {
  const target = new File(Paths.cache, `${DOWNLOAD_PREFIX}${newIdempotencyKey()}.${extension}`);
  const file = await File.downloadFileAsync(`${apiUrl()}${path}`, target, {
    headers: authHeaders('application/pdf'),
  });
  return file.uri;
}

export function deleteDownload(uri: string): void {
  deleteQuietly(new File(uri));
}

/**
 * A PDF attachment: downloaded, handed to the system share sheet, and deleted when the sheet
 * closes. No PDF is kept (slice-16 §5.3).
 */
export async function openPdf(path: string): Promise<void> {
  const uri = await downloadToCache(path, 'pdf');
  try {
    await shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Open PDF' });
  } finally {
    deleteDownload(uri);
  }
}
