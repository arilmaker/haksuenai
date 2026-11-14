import { badRequest } from './http';

export type Obj = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'system', 'moderator', 'official',
  'r1zchatid', 'r1zchat', 'r1z', 'api', 'null', 'undefined', 'everyone', 'me',
]);

export const isUuid = (x: unknown): x is string => typeof x === 'string' && UUID_RE.test(x);

export function uuid(x: unknown, name: string): string {
  if (!isUuid(x)) throw badRequest(`${name} tidak valid`);
  return x.toLowerCase();
}

export function str(x: unknown, name: string, min = 1, max = 500): string {
  if (typeof x !== 'string') throw badRequest(`${name} wajib diisi`);
  const s = x.trim();
  if (s.length < min || s.length > max) {
    throw badRequest(min === max ? `${name} harus ${min} karakter` : `${name} harus ${min}-${max} karakter`);
  }
  return s;
}

export function optStr(x: unknown, name: string, max = 500): string | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'string') throw badRequest(`${name} tidak valid`);
  const s = x.trim();
  if (s.length > max) throw badRequest(`${name} maksimal ${max} karakter`);
  return s;
}

export function email(x: unknown): string {
  const s = str(x, 'Email', 5, 320).toLowerCase();
  if (!EMAIL_RE.test(s)) throw badRequest('Format email tidak valid');
  return s;
}

export function int(x: unknown, name: string, min: number, max: number): number {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) {
    throw badRequest(`${name} harus bilangan bulat ${min}-${max}`);
  }
  return x;
}

export function bool(x: unknown, name: string): boolean {
  if (typeof x !== 'boolean') throw badRequest(`${name} harus true/false`);
  return x;
}

export function optBool(x: unknown, name: string): boolean | undefined {
  return x === undefined || x === null ? undefined : bool(x, name);
}

export function oneOf<T extends string>(x: unknown, name: string, list: readonly T[]): T {
  if (typeof x !== 'string' || !(list as readonly string[]).includes(x)) {
    throw badRequest(`${name} harus salah satu dari: ${list.join(', ')}`);
  }
  return x as T;
}

export function arr(x: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(x) || x.length > max) throw badRequest(`${name} harus berupa daftar (maks ${max})`);
  return x;
}

export function obj(x: unknown, name: string): Obj {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw badRequest(`${name} tidak valid`);
  return x as Obj;
}

export function b64(x: unknown, name: string, max: number): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > max || !B64_RE.test(x)) {
    throw badRequest(`${name} tidak valid`);
  }
  return x;
}

export function username(x: unknown): string {
  const s = str(x, 'Username', 1, 40).toLowerCase().replace(/^@/, '');
  if (!USERNAME_RE.test(s)) throw badRequest('Username 3-20 karakter: huruf kecil, angka, dan _');
  return s;
}

export function color(x: unknown, name = 'Warna'): string {
  const s = str(x, name, 7, 7);
  if (!COLOR_RE.test(s)) throw badRequest(`${name} harus format #RRGGBB`);
  return s;
}

export function emoji(x: unknown, name = 'Emoji'): string {
  return str(x, name, 1, 16);
}
