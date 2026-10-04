import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { authHeaders } from '../api/client';
import { openPdf } from '../media/files';
import { apiUrl } from '../platform/config';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { Button } from './Button';
import { colors, fontSize, radius, space } from './theme';

// The only importer of expo-image (lint, R160, slice-16 §5.3): nothing loads before a tap. The
// first tap loads the thumbnail, a second the original; the size is shown first so a metered
// parent decides. The bearer travels in a header, never in the URL. A PDF is downloaded, handed
// to the share sheet and deleted.

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Every image the app has shown, from the disk cache (the wipes, slice-16 §13.3). */
export async function clearImageCache(): Promise<void> {
  try {
    await Image.clearDiskCache();
  } catch (error) {
    log('warn', 'image.cache_clear_failed', errorFields(error));
  }
}

type Props = {
  /** The entry's path; `/thumbnail` and `/attachment` are appended. */
  basePath: string;
  mime: string | null;
  sizeBytes: number | null;
  /** Needs a connection: a tap offline says so instead of loading. */
  online: boolean;
  /** What the image is, for the screen reader ("Diary photo"). */
  label?: string;
};

export function Attachment({ basePath, mime, sizeBytes, online, label = 'Diary photo' }: Props) {
  const [step, setStep] = useState<'none' | 'thumbnail' | 'full'>('none');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const size = formatBytes(sizeBytes);

  if (failed) {
    return (
      <Text style={styles.note} testID="attachment.gone">
        This file is no longer available.
      </Text>
    );
  }

  if (mime === 'application/pdf') {
    return (
      <View style={styles.wrap}>
        <Button
          label={`Open PDF${size ? ` (${size})` : ''}`}
          variant="secondary"
          busy={busy}
          disabled={!online}
          onPress={() => {
            setBusy(true);
            void openPdf(`${basePath}/attachment`)
              .catch((error: unknown) => {
                log('info', 'attachment.pdf_failed', errorFields(error));
                setFailed(true);
              })
              .finally(() => setBusy(false));
          }}
          testID="attachment.openPdf"
        />
        {!online ? <Text style={styles.note}>Needs a connection</Text> : null}
      </View>
    );
  }

  const source = (kind: 'thumbnail' | 'attachment') => ({
    uri: `${apiUrl()}${basePath}/${kind}`,
    headers: authHeaders(),
  });

  return (
    <View style={styles.wrap}>
      {step === 'none' ? (
        <>
          <Button
            label="Show photo"
            variant="secondary"
            disabled={!online}
            onPress={() => setStep('thumbnail')}
            testID="attachment.show"
          />
          <Text style={styles.note}>
            {online ? `${size ? `${size} — ` : ''}opens on tap` : 'Needs a connection'}
          </Text>
        </>
      ) : (
        <>
          <Image
            source={source(step === 'full' ? 'attachment' : 'thumbnail')}
            cachePolicy="disk"
            contentFit="contain"
            style={step === 'full' ? styles.full : styles.thumbnail}
            onError={() => setFailed(true)}
            accessibilityLabel={label}
            testID={step === 'full' ? 'attachment.full' : 'attachment.thumbnail'}
          />
          {step === 'thumbnail' ? (
            <Button
              label={`Show full size${size ? ` (${size})` : ''}`}
              variant="secondary"
              disabled={!online}
              onPress={() => setStep('full')}
              testID="attachment.showFull"
            />
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  thumbnail: { width: 160, height: 160, borderRadius: radius, backgroundColor: colors.muted },
  full: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius, backgroundColor: colors.muted },
});
