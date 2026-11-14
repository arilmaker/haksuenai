// Pembaca environment variable. Dibaca saat dipanggil (bukan saat import) supaya mudah dites.
export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} belum diisi`);
  return v;
}
export const opt = (name: string, fallback = ''): string => process.env[name] || fallback;
export const jwtSecret = () => need('JWT_SECRET');
export const otpSecret = () => need('OTP_SECRET');
