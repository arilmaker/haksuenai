import { isBlockedEitherWay, requireMember } from '../access';
import { sql } from '../db';
import { emitToUsers } from '../events';
import { opt } from '../env';
import { badRequest, conflict, created, forbidden, notFound, readJson } from '../http';
import { publicUser } from '../presenter';
import type { Router } from '../router';
import * as v from '../validate';

function iceServers() {
  const servers: Array<Record<string, unknown>> = [
    { urls: opt('STUN_URLS', 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean) },
  ];
  const turn = opt('TURN_URLS');
  if (turn) {
    servers.push({
      urls: turn.split(',').map((s) => s.trim()).filter(Boolean),
      username: opt('TURN_USERNAME'),
      credential: opt('TURN_CREDENTIAL'),
    });
  }
  return servers;
}

async function loadCall(id: string, uid: string) {
  const [c] = await sql`select * from calls where id = ${id}::uuid and (caller_id = ${uid}::uuid or callee_id = ${uid}::uuid)`;
  if (!c) throw notFound('Panggilan tidak ditemukan');
  return c;
}

/**
 * Penyampai sinyal WebRTC. Media suara/video berjalan peer-to-peer (terenkripsi DTLS-SRTP).
 * Isi sinyal (SDP/ICE) sendiri sudah dienkripsi E2EE oleh aplikasi, server hanya meneruskan.
 */
export function registerCalls(r: Router) {
  r.add('GET', '/calls/ice', async () => ({ iceServers: iceServers() }));

  // Riwayat panggilan saya
  r.add('GET', '/calls', async ({ uid }) => {
    const rows = await sql`
      select c.id, c.conversation_id, c.kind,
        case when c.status = 'ringing' and c.created_at < now() - interval '90 seconds' then 'missed' else c.status end as status,
        c.created_at, c.answered_at, c.ended_at, (c.caller_id = ${uid}::uuid) as outgoing,
        u.id as peer_id, u.username, u.display_name, u.about, u.avatar_emoji, u.avatar_color, u.public_key
      from calls c
      join users u on u.id = case when c.caller_id = ${uid}::uuid then c.callee_id else c.caller_id end
      where c.caller_id = ${uid}::uuid or c.callee_id = ${uid}::uuid
      order by c.created_at desc limit 50`;
    return {
      calls: rows.map((c) => ({
        id: c.id,
        conversationId: c.conversation_id,
        kind: c.kind,
        status: c.status,
        outgoing: c.outgoing,
        createdAt: c.created_at,
        durationSec:
          c.answered_at && c.ended_at ? Math.max(0, Math.round((+new Date(c.ended_at) - +new Date(c.answered_at)) / 1000)) : 0,
        peer: publicUser({ ...c, id: c.peer_id }),
      })),
    };
  });

  // Mulai panggilan (chat pribadi saja)
  r.add('POST', '/calls', async ({ req, uid }) => {
    const b = await readJson(req);
    const cid = v.uuid(b.conversationId, 'conversationId');
    const kind = v.oneOf(b.kind, 'kind', ['voice', 'video'] as const);
    const m = await requireMember(cid, uid);
    if (m.kind !== 'direct') throw badRequest('Panggilan hanya untuk chat pribadi');

    const [peer] = await sql`select user_id from conversation_members where conversation_id = ${cid}::uuid and user_id <> ${uid}::uuid`;
    if (!peer) throw notFound('Lawan bicara tidak ditemukan');
    if (await isBlockedEitherWay(uid, peer.user_id)) throw forbidden('Tidak bisa menelepon pengguna ini');

    const [busy] = await sql`
      select 1 as x from calls
      where (caller_id = ${peer.user_id}::uuid or callee_id = ${peer.user_id}::uuid)
        and ((status = 'ringing' and created_at > now() - interval '60 seconds') or (status = 'answered' and ended_at is null))
      limit 1`;
    if (busy) throw conflict('Pengguna sedang dalam panggilan lain', { code: 'busy' });

    const [call] = await sql`
      insert into calls (conversation_id, caller_id, callee_id, kind)
      values (${cid}::uuid, ${uid}::uuid, ${peer.user_id}::uuid, ${kind}) returning id`;
    const [caller] = await sql`select * from users where id = ${uid}::uuid`;
    await emitToUsers([peer.user_id], 'call.incoming', {
      callId: call.id, conversationId: cid, kind, from: publicUser(caller),
    });
    return created({ callId: call.id, iceServers: iceServers() });
  });

  // Kirim sinyal (offer/answer/ice) — data sudah terenkripsi dari klien
  r.add('POST', '/calls/:id/signal', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const call = await loadCall(id, uid);
    if (call.status !== 'ringing' && call.status !== 'answered') throw badRequest('Panggilan sudah selesai');
    const b = await readJson(req);
    const type = v.oneOf(b.type, 'type', ['offer', 'answer', 'ice'] as const);
    const data = v.str(b.data, 'data', 1, 40_000);
    const to = call.caller_id === uid ? call.callee_id : call.caller_id;
    await emitToUsers([to], 'call.signal', { callId: id, from: uid, type, data });
    return { ok: true };
  });

  r.add('POST', '/calls/:id/accept', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const call = await loadCall(id, uid);
    if (call.callee_id !== uid) throw forbidden('Hanya penerima yang bisa menjawab');
    const done = await sql`update calls set status = 'answered', answered_at = now()
                           where id = ${id}::uuid and status = 'ringing' returning id`;
    if (!done.length) throw conflict('Panggilan sudah tidak berdering');
    await emitToUsers([call.caller_id], 'call.state', { callId: id, status: 'answered' });
    return { ok: true };
  });

  r.add('POST', '/calls/:id/decline', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const call = await loadCall(id, uid);
    if (call.callee_id !== uid) throw forbidden('Hanya penerima yang bisa menolak');
    await sql`update calls set status = 'declined', ended_at = now() where id = ${id}::uuid and status = 'ringing'`;
    await emitToUsers([call.caller_id], 'call.state', { callId: id, status: 'declined' });
    return { ok: true };
  });

  // Akhiri. reason: 'timeout' (penelepon menyerah, tak dijawab) | 'hangup'
  r.add('POST', '/calls/:id/end', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const call = await loadCall(id, uid);
    const reason = (await readJson(req)).reason === 'timeout' ? 'timeout' : 'hangup';
    let status: string;
    if (call.status === 'ringing') status = reason === 'timeout' && call.caller_id === uid ? 'missed' : 'canceled';
    else status = 'ended';
    await sql`update calls set status = ${status}, ended_at = now()
              where id = ${id}::uuid and status in ('ringing','answered')`;
    const other = call.caller_id === uid ? call.callee_id : call.caller_id;
    await emitToUsers([other], 'call.state', { callId: id, status });
    return { ok: true, status };
  });
}
