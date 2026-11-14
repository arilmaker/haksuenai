import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error('DATABASE_URL belum diisi (sambungkan database Neon di Vercel Storage)');

/** Tagged template: await sql`select ... where id = ${id}` -> array of rows. */
export const sql = neon(url);
export type Row = Record<string, any>;
