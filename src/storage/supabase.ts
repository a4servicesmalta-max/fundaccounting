// Supabase-backed storage primitives (used only when STORAGE_DRIVER=supabase).
//
// Two responsibilities:
//   1. The single "books" JSON blob  -> a row in the `app_kv` table.
//   2. Original uploaded document bytes -> objects in a private Storage bucket.
//
// The client is created lazily on first use so that importing this module (e.g.
// from the file-driver code path or the test suite) never requires Supabase
// credentials to be present.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function sb(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for the supabase storage driver.',
    );
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

const KV_TABLE = 'app_kv';
const BLOB_KEY = 'books';
const BUCKET = process.env.SUPABASE_BUCKET || 'documents';

// --- Books blob (whole-store, single row) ------------------------------------

/** Load the books blob, or null if it has never been written. */
export async function loadBlobRemote(): Promise<unknown | null> {
  const { data, error } = await sb()
    .from(KV_TABLE)
    .select('value')
    .eq('key', BLOB_KEY)
    .maybeSingle();
  if (error) throw new Error(`Supabase load failed: ${error.message}`);
  return data ? (data as { value: unknown }).value : null;
}

/** Upsert the whole books blob under the single well-known key. */
export async function saveBlobRemote(value: unknown): Promise<void> {
  const { error } = await sb()
    .from(KV_TABLE)
    .upsert(
      { key: BLOB_KEY, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) throw new Error(`Supabase save failed: ${error.message}`);
}

// --- Object storage (original uploaded bytes) --------------------------------

export async function putObjectRemote(
  key: string,
  buffer: Buffer,
  contentType?: string,
): Promise<void> {
  const { error } = await sb()
    .storage.from(BUCKET)
    .upload(key, buffer, {
      contentType: contentType || 'application/octet-stream',
      upsert: true,
    });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
}

export async function getObjectRemote(key: string): Promise<Buffer> {
  const { data, error } = await sb().storage.from(BUCKET).download(key);
  if (error || !data) {
    throw new Error(`Supabase download failed: ${error?.message ?? 'no data'}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
