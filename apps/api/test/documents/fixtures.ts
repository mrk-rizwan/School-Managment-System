// Upload payloads for the slice-6 upload and document tests, built in memory: real images from
// sharp, a minimal PDF, and the hostile files R42 must refuse.
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

/** A marker written into EXIF; it must not survive the re-encode. */
export const EXIF_MARKER = 'asms-exif-marker-gps-home';

export const jpegWithExif = (): Promise<Buffer> =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: '#c0392b' } })
    .jpeg()
    .withExif({ IFD0: { Artist: EXIF_MARKER, Copyright: EXIF_MARKER } })
    .toBuffer();

export const png = (width = 24, height = 24): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 4, background: '#2e86c1' } })
    .png()
    .toBuffer();

export const gif = (): Promise<Buffer> =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
    .gif()
    .toBuffer();

export const pdf = (): Buffer =>
  Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );

export const svg = (): Buffer =>
  Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );

export const html = (): Buffer =>
  Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');

/**
 * A valid small PNG whose header claims 30000 x 30000 pixels (900 MP): a decompression bomb. The
 * IHDR CRC is recomputed so the decoder trusts the header and refuses on the pixel limit.
 */
export async function pixelBombPng(): Promise<Buffer> {
  const out = Buffer.from(await png(8, 8));
  // Signature (8) + length (4) + "IHDR" (4): width at 16, height at 20, CRC after the 13-byte body.
  out.writeUInt32BE(30_000, 16);
  out.writeUInt32BE(30_000, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}
