import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { opt } from './env';
import { config } from './config';

let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.gmail, pass: config.appPassword },
    });
  }
  return transporter;
}

/** Email OTP bergaya komik: tabel biru-hitam-merah + tombol salin di bawah. */
export function otpEmailHtml(code: string, appUrl: string): string {
  const digits = code
    .split('')
    .map(
      (d) =>
        `<td style="background:#111111;color:#ffffff;font:bold 30px 'Courier New',monospace;width:44px;height:56px;text-align:center;border:3px solid #111111;border-radius:8px;">${d}</td><td width="6"></td>`,
    )
    .join('');
  const salin = `${appUrl.replace(/\/+$/, '')}/api/salin?kode=${encodeURIComponent(code)}`;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#0d47a1;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d47a1;padding:24px 0;">
 <tr><td align="center">
  <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;background:#ffffff;border:4px solid #111111;border-radius:16px;font-family:Arial,Helvetica,sans-serif;">
   <tr><td style="background:#1e88e5;border-bottom:4px solid #111111;border-radius:12px 12px 0 0;padding:18px;text-align:center;">
     <span style="font:bold 28px Impact,Arial Black,sans-serif;color:#ffffff;letter-spacing:2px;">💬 R1ZCHATID</span>
   </td></tr>
   <tr><td style="padding:24px 20px 8px 20px;text-align:center;color:#111111;">
     <div style="display:inline-block;background:#e53935;color:#ffffff;font:bold 14px Arial,sans-serif;padding:6px 14px;border:3px solid #111111;border-radius:20px;">💥 KODE OTP KAMU</div>
     <p style="margin:16px 0 4px 0;font-size:15px;">Masukkan kode ini di aplikasi untuk masuk atau mendaftar:</p>
   </td></tr>
   <tr><td align="center" style="padding:8px 20px;">
     <table role="presentation" cellpadding="0" cellspacing="0"><tr>${digits}</tr></table>
   </td></tr>
   <tr><td style="padding:8px 24px 4px 24px;text-align:center;color:#333333;font-size:13px;">
     ⏱️ Berlaku <b>10 menit</b>. Jangan bagikan kode ini ke siapa pun, termasuk yang mengaku dari R1ZCHATID.
   </td></tr>
   <tr><td align="center" style="padding:16px 20px 24px 20px;">
     <a href="${salin}" style="display:inline-block;background:#e53935;color:#ffffff;text-decoration:none;font:bold 16px Arial,sans-serif;padding:12px 28px;border:3px solid #111111;border-radius:12px;box-shadow:4px 4px 0 #111111;">📋 SALIN KODE</a>
   </td></tr>
   <tr><td style="background:#111111;color:#bbbbbb;text-align:center;font-size:11px;padding:10px;border-radius:0 0 12px 12px;">
     Kalau bukan kamu yang meminta, abaikan email ini.
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

export async function sendOtpMail(to: string, code: string): Promise<void> {
  const from = opt('OTP_FROM') || `R1ZCHATID <${config.gmail}>`;
  await getTransporter().sendMail({
    from,
    to,
    subject: `${code} adalah kode OTP R1ZCHATID kamu`,
    text: `Kode OTP R1ZCHATID kamu: ${code}\nBerlaku 10 menit. Jangan bagikan ke siapa pun.`,
    html: otpEmailHtml(code, opt('APP_URL', 'https://example.vercel.app')),
  });
}

export function salinPageHtml(code: string): string {
  const safe = code.replace(/\D/g, '').slice(0, 6);
  return `<!doctype html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Salin Kode — R1ZCHATID</title></head>
<body style="margin:0;background:#0d47a1;font-family:Arial,sans-serif;text-align:center;padding:48px 16px;">
<div style="max-width:380px;margin:auto;background:#fff;border:4px solid #111;border-radius:16px;padding:24px;box-shadow:6px 6px 0 #111;">
 <h2 style="margin:0 0 12px;color:#1e88e5;font-family:Impact,Arial Black,sans-serif;letter-spacing:2px;">💬 R1ZCHATID</h2>
 <div id="k" style="font:bold 40px 'Courier New',monospace;letter-spacing:8px;color:#e53935;margin:12px 0;">${safe}</div>
 <button id="b" style="background:#e53935;color:#fff;border:3px solid #111;border-radius:12px;padding:12px 28px;font:bold 16px Arial;box-shadow:4px 4px 0 #111;">📋 SALIN KODE</button>
</div>
<script>
document.getElementById('b').onclick=async function(){
  try{await navigator.clipboard.writeText(document.getElementById('k').textContent);this.textContent='✅ TERSALIN!';}
  catch(e){this.textContent='Tekan lama angka untuk menyalin';}
};
</script></body></html>`;
}
