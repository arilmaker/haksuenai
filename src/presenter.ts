import type { Row } from './db';

export type TickStatus = 'sent' | 'delivered' | 'read';

export function publicUser(r: Row) {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    about: r.about,
    avatarEmoji: r.avatar_emoji,
    avatarColor: r.avatar_color,
    publicKey: r.public_key,
  };
}

export function selfUser(r: Row) {
  return {
    ...publicUser(r),
    email: r.email,
    showLastSeen: r.show_last_seen,
    readReceipts: r.read_receipts,
    createdAt: r.created_at,
  };
}

/**
 * Centang untuk pesan milik pengirim.
 *  sent      = ✓   sudah di server, penerima belum online / belum menerima
 *  delivered = ✓✓  sudah sampai di perangkat penerima
 *  read      = ✓✓ biru, sudah dibuka penerima (hanya jika "centang biru" penerima aktif)
 */
export function tickStatus(nOthers: number, nDelivered: number, nRead: number): TickStatus {
  if (nOthers <= 0) return 'sent';
  if (nRead >= nOthers) return 'read';
  if (nDelivered >= nOthers) return 'delivered';
  return 'sent';
}

export function mapMessage(r: Row, uid: string) {
  const deleted = !!r.deleted_at;
  const own = r.sender_id === uid;
  const nOthers = Number(r.n_others ?? 0);
  const nDelivered = Number(r.n_delivered ?? 0);
  const nRead = Number(r.n_read ?? 0);
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    kind: r.kind,
    ciphertext: deleted ? '' : r.ciphertext,
    nonce: deleted ? '' : r.nonce,
    senderKey: r.sender_key,
    wrappedKey: r.wrapped_key ?? null,
    wrapNonce: r.wrap_nonce ?? null,
    replyTo: r.reply_to ?? null,
    expiresAt: r.expires_at ?? null,
    editedAt: r.edited_at ?? null,
    deleted,
    createdAt: r.created_at,
    starred: !!r.starred,
    reactions: r.reactions ?? [],
    receipts: own ? { total: nOthers, delivered: nDelivered, read: nRead } : null,
    status: own ? tickStatus(nOthers, nDelivered, nRead) : null,
  };
}
