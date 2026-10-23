/*
  The recap's images (docs/spec.md, "Recap editor"). Uploaded by the owner,
  stored at `images/{install}/{meeting}/{id}.{ext}`, and served only through
  the meeting's permission-checked route; never a public URL. The type is
  taken from the file's first bytes, not from what the browser says.
*/
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const;
export type ImageExt = keyof typeof TYPES;

export const IMAGE_FILE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|gif|webp)$/;

/** The image's kind from its magic bytes, or null when it is none of the four. */
export function sniffImage(bytes: Uint8Array): ImageExt | null {
  const at = (i: number, ...values: number[]) => values.every((v, j) => bytes[i + j] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  return null;
}

export const imageType = (ext: ImageExt) => TYPES[ext];

export const imagePrefix = (installId: string, meetingId: string) =>
  `images/${installId}/${meetingId}/`;
export const imageKey = (installId: string, meetingId: string, file: string) =>
  `${imagePrefix(installId, meetingId)}${file}`;
export const imageSrc = (meetingId: string, file: string) =>
  `/api/v1/meetings/${meetingId}/recap/images/${file}`;
