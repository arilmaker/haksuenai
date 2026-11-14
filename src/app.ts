import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireUser } from './auth';
import { applyCors, notFound, Reply, sendError, sendReply, HttpError } from './http';
import { Router } from './router';
import { registerAuth } from './routes/auth';
import { registerMe } from './routes/me';
import { registerUsers } from './routes/users';
import { registerBlocks } from './routes/blocks';
import { registerConversations } from './routes/conversations';
import { registerGroups } from './routes/groups';
import { registerMessages } from './routes/messages';
import { registerStatuses } from './routes/statuses';
import { registerCalls } from './routes/calls';
import { registerMedia } from './routes/media';
import { registerEvents } from './routes/events';
import { registerMisc } from './routes/misc';
import { registerChannels } from './routes/channels';

export function buildRouter(): Router {
  const r = new Router();
  registerMisc(r);
  registerAuth(r);
  registerMe(r);
  registerUsers(r);
  registerBlocks(r);
  registerConversations(r);
  registerGroups(r);
  registerMessages(r);
  registerStatuses(r);
  registerCalls(r);
  registerMedia(r);
  registerChannels(r);
  registerEvents(r);
  return r;
}

const router = buildRouter();

export async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applyCors(res);
  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    const hit = router.match(method, path);
    if (!hit) {
      if (router.pathExists(path)) throw new HttpError(405, 'Method tidak diizinkan');
      throw notFound('Endpoint tidak ada');
    }
    const uid = hit.route.isPublic ? '' : await requireUser(req);
    const out = await hit.route.handler({ req, res, params: hit.params, query: url.searchParams, uid });
    sendReply(res, out instanceof Reply ? out : new Reply(200, out ?? { ok: true }));
  } catch (err) {
    sendError(res, err);
  }
}
