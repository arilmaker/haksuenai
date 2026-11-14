// Fake untuk dependency eksternal supaya test bisa jalan tanpa database/email sungguhan.
import Module from 'node:module';

process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret';
process.env.OTP_SECRET = 'test-otp-secret-test-otp-secret';
process.env.DATABASE_URL = 'postgres://fake';
process.env.GMAIL_USER = 'tes@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'x';
process.env.APP_URL = 'https://api.test';
process.env.CRON_SECRET = 'cron-secret';

export interface Call { text: string; values: any[] }
type Responder = (values: any[], text: string) => any[];

export const fake = {
  calls: [] as Call[],
  mails: [] as Array<Record<string, any>>,
  mailFail: false,
  rules: [] as Array<{ re: RegExp; fn: Responder }>,
  reset() { this.calls = []; this.mails = []; this.rules = []; this.mailFail = false; },
  /** Jawab query yang teksnya cocok dengan regex. Aturan terbaru didahulukan. */
  on(re: RegExp, fn: Responder | any[]) {
    this.rules.unshift({ re, fn: Array.isArray(fn) ? () => fn : fn });
  },
  ran(re: RegExp) { return this.calls.filter((c) => re.test(c.text)); },
  /** Event antrean bertipe `type` yang di-insert (tipe dikirim sebagai parameter SQL). */
  events(type: string) { return this.calls.filter((c) => /insert into events/.test(c.text) && c.values.includes(type)); },
};

function runQuery(text: string, values: any[]): any[] {
  fake.calls.push({ text, values });
  for (const r of fake.rules) if (r.re.test(text)) return r.fn(values, text);
  return [];
}

function neon() {
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
    const q: any = { text, values };
    // lazy: baru "dieksekusi" saat di-await atau masuk transaction (meniru neon)
    q.then = (res: any, rej: any) => Promise.resolve().then(() => runQuery(text, values)).then(res, rej);
    return q;
  };
  sql.transaction = async (qs: any[]) => qs.map((q) => runQuery(q.text, q.values));
  return sql;
}

const blobDeleted: string[] = [];
export const blob = { deleted: blobDeleted, puts: [] as string[] };

const fakes: Record<string, any> = {
  '@neondatabase/serverless': { neon },
  '@vercel/blob': {
    put: async (path: string) => { blob.puts.push(path); return { url: `https://blob.test/${path}` }; },
    del: async (u: string | string[]) => { blobDeleted.push(...(Array.isArray(u) ? u : [u])); },
  },
  nodemailer: {
    createTransport: () => ({
      sendMail: async (m: Record<string, any>) => {
        if (fake.mailFail) throw new Error('smtp down');
        fake.mails.push(m);
        return {};
      },
    }),
  },
};
fakes.nodemailer.default = fakes.nodemailer;

const M = Module as any;
const origLoad = M._load;
M._load = function (request: string, ...rest: any[]) {
  if (fakes[request]) return fakes[request];
  return origLoad.call(this, request, ...rest);
};
