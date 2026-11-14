import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/app';

// Satu-satunya Vercel Function: semua endpoint /api/* masuk lewat sini ke router.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await app(req, res);
}
