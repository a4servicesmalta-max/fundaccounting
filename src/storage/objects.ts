// Object storage for original uploaded document bytes.
//
// Driver-selected by STORAGE_DRIVER:
//   - 'file' (default): bytes live under <cwd>/data/uploads/... exactly as before,
//     so local dev and the test suite are unchanged.
//   - 'supabase': bytes live in a private Supabase Storage bucket.
//
// A stored key is what we persist in DocumentRecord.storedPath. For the file
// driver it stays the familiar `data/uploads/<id>.<ext>`; for supabase it is the
// bucket-relative `uploads/<id>.<ext>`. readObject() accepts either shape.

import * as fs from 'fs';
import * as path from 'path';

const DRIVER = process.env.STORAGE_DRIVER === 'supabase' ? 'supabase' : 'file';

/** Bucket-relative key (no leading slash, no leading `data/`). */
function normalizeKey(key: string): string {
  return key.replace(/^[\\/]+/, '').replace(/^data[\\/]+/, '');
}

/** Local on-disk relative path for a key (always under data/). */
function localRel(key: string): string {
  return path.join('data', normalizeKey(key));
}

/** Build the storage key for a document's original bytes. */
export function uploadKey(id: string, ext: string): string {
  return `uploads/${id}.${ext}`;
}

/** Persist bytes for `key`; returns the value to store in `storedPath`. */
export async function saveObject(
  key: string,
  buffer: Buffer,
  contentType?: string,
): Promise<string> {
  if (DRIVER === 'supabase') {
    const { putObjectRemote } = await import('./supabase');
    const k = normalizeKey(key);
    await putObjectRemote(k, buffer, contentType);
    return k;
  }
  const rel = localRel(key);
  const abs = path.resolve(process.cwd(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel;
}

/** Read the bytes previously stored under `storedPath` (either key shape). */
export async function readObject(storedPath: string): Promise<Buffer> {
  if (DRIVER === 'supabase') {
    const { getObjectRemote } = await import('./supabase');
    return getObjectRemote(normalizeKey(storedPath));
  }
  return fs.readFileSync(path.resolve(process.cwd(), localRel(storedPath)));
}
