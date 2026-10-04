import { newIdempotencyKey } from '@asms/shared';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
  requestMediaLibraryPermissionsAsync,
} from 'expo-image-picker';
import type { LocalPhoto } from '../db/local.repository';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { deleteOutboxFile, deleteTemporaryFile, storePickedPhoto } from './files';

// The only importer of expo-image-picker and expo-image-manipulator (lint, slice-16 §4.5): a
// diary photo is taken or chosen (JPEG or PNG, no editing, no EXIF), downscaled to 1600 px on
// its longest side at JPEG quality 0.8 — the output carries no EXIF — and moved into the app's
// private outbox folder. Nothing is written to the camera roll.

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.8;
/** The server's upload limit (slice-6 §6.1): refused on the device before it is stored. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export type PickResult =
  | { kind: 'picked'; photo: LocalPhoto }
  | { kind: 'cancelled' }
  | { kind: 'refused'; message: string };

export async function pickPhoto(source: 'camera' | 'library'): Promise<PickResult> {
  const permission =
    source === 'camera'
      ? await requestCameraPermissionsAsync()
      : await requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      kind: 'refused',
      message:
        source === 'camera'
          ? 'Camera permission is off. Allow it in the phone’s settings.'
          : 'Photo access is off. Allow it in the phone’s settings.',
    };
  }
  const options = {
    mediaTypes: ['images' as const],
    allowsEditing: false,
    exif: false,
    quality: 1,
  };
  const result =
    source === 'camera' ? await launchCameraAsync(options) : await launchImageLibraryAsync(options);
  if (result.canceled) return { kind: 'cancelled' };
  const asset = result.assets[0];
  if (asset === undefined) return { kind: 'cancelled' };
  if (asset.mimeType !== undefined && !/^image\/(jpeg|png)$/.test(asset.mimeType)) {
    return { kind: 'refused', message: 'Choose a JPEG or PNG photo.' };
  }

  try {
    const longest = Math.max(asset.width, asset.height);
    const context = ImageManipulator.manipulate(asset.uri);
    if (longest > MAX_EDGE_PX) {
      context.resize(
        asset.width >= asset.height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX },
      );
    }
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });
    const id = newIdempotencyKey();
    const stored = storePickedPhoto(saved.uri, id);
    deleteTemporaryFile(asset.uri);
    if (stored.sizeBytes > MAX_PHOTO_BYTES) {
      deleteOutboxFile(stored.fileName);
      return { kind: 'refused', message: 'Photo too large' };
    }
    return {
      kind: 'picked',
      photo: { id, fileName: stored.fileName, mime: 'image/jpeg', sizeBytes: stored.sizeBytes },
    };
  } catch (error) {
    log('warn', 'media.photo_failed', errorFields(error));
    return { kind: 'refused', message: 'The photo could not be prepared. Try again.' };
  }
}
