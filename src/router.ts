import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  uid: string; // string kosong untuk route publik
}
export type Handler = (c: Ctx) => Promise<unknown>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
  isPublic: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: { public?: boolean } = {}) {
    const keys: string[] = [];
    const src = pattern.replace(/:([A-Za-z]+)/g, (_m, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${src}$`), keys, handler, isPublic: !!opts.public });
  }

  /** Route yang terdaftar lebih dulu menang (daftarkan yang spesifik sebelum yang berparameter). */
  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.re.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
    return null;
  }

  pathExists(path: string): boolean {
    return this.routes.some((r) => r.re.test(path));
  }
}
