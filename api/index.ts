// Vercel serverless entrypoint.
//
// The Express app (imported from src/server) already carries the auth gate and,
// under STORAGE_DRIVER=supabase, the per-request load/save lifecycle. So this
// handler just forwards the incoming request to the app. No app.listen() runs
// on Vercel (guarded in server.ts by require.main / VERCEL).

import type { IncomingMessage, ServerResponse } from 'http';
import { app } from '../src/server';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}
