-- R1ZCHATID — skema database (Neon Postgres). Aman dijalankan berulang kali.
-- Jalankan di Neon SQL Editor sekali saat setup, dan lagi setiap ada pembaruan versi.

create extension if not exists pgcrypto;

-- ───────────── Akun ─────────────
create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique,
  username       text unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name   text,
  about          text not null default 'Hai! Aku pakai R1ZCHATID 💬',
  avatar_emoji   text not null default '😎',
  avatar_color   text not null default '#FFD43B',
  public_key     text,                                  -- X25519 (base64url). Private key TIDAK pernah ke server.
  show_last_seen boolean not null default true,
  read_receipts  boolean not null default true,         -- centang biru
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now()
);

create table if not exists otp_codes (
  email             text primary key,
  code_hash         text not null,                      -- HMAC, kode asli tidak disimpan
  expires_at        timestamptz not null,
  attempts          int not null default 0,
  sent_count        int not null default 1,
  window_started_at timestamptz not null default now(),
  last_sent_at      timestamptz not null default now()
);

create table if not exists blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);
create index if not exists blocks_blocked_idx on blocks (blocked_id);

-- ───────────── Percakapan ─────────────
create table if not exists conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('direct','group')),
  title       text,
  icon_emoji  text not null default '👥',
  icon_color  text not null default '#4DABF7',
  direct_key  text unique,                              -- "idA:idB" (terurut) supaya chat pribadi tidak dobel
  ttl_seconds int check (ttl_seconds is null or ttl_seconds > 0),  -- pesan hilang otomatis
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner','admin','member')),
  pinned          boolean not null default false,
  archived        boolean not null default false,
  muted           boolean not null default false,
  hidden          boolean not null default false,       -- "hapus chat" (hilang dari daftar sampai ada pesan baru)
  cleared_at      timestamptz,                          -- riwayat sebelum waktu ini disembunyikan untuk saya
  last_read_at    timestamptz,                          -- batas baca pribadi (badge belum dibaca)
  typing_at       timestamptz,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists cm_user_idx on conversation_members (user_id);

-- ───────────── Pesan (hanya ciphertext) ─────────────
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid not null references users(id) on delete cascade,
  kind            text not null default 'text'
                  check (kind in ('text','image','video','audio','document','sticker','poll','vote')),
  ciphertext      text not null,
  nonce           text not null,
  sender_key      text not null,                        -- public key pengirim saat mengirim
  reply_to        uuid references messages(id) on delete set null,
  expires_at      timestamptz,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages (conversation_id, created_at desc);
create index if not exists messages_expires_idx on messages (expires_at) where expires_at is not null;

-- Kunci isi pesan, dibungkus (dienkripsi) khusus untuk tiap anggota.
create table if not exists message_keys (
  message_id  uuid not null references messages(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  wrapped_key text not null,
  wrap_nonce  text not null,
  primary key (message_id, user_id)
);

create table if not exists message_receipts (
  message_id   uuid not null references messages(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  delivered_at timestamptz,
  read_at      timestamptz,
  primary key (message_id, user_id)
);

create table if not exists message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) <= 16),
  primary key (message_id, user_id)
);

create table if not exists message_hidden (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  primary key (message_id, user_id)
);

create table if not exists message_stars (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  primary key (message_id, user_id)
);

-- ───────────── Antrean event (pengganti WebSocket) ─────────────
create table if not exists events (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  type       text not null,
  payload    jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index if not exists events_user_idx on events (user_id, id);

-- ───────────── Status 24 jam (terenkripsi) ─────────────
create table if not exists statuses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  ciphertext text not null,
  nonce      text not null,
  sender_key text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index if not exists statuses_user_idx on statuses (user_id, created_at desc);

create table if not exists status_keys (
  status_id   uuid not null references statuses(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  wrapped_key text not null,
  wrap_nonce  text not null,
  primary key (status_id, user_id)
);
create index if not exists status_keys_user_idx on status_keys (user_id);

create table if not exists status_views (
  status_id uuid not null references statuses(id) on delete cascade,
  viewer_id uuid not null references users(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (status_id, viewer_id)
);

-- ───────────── Panggilan ─────────────
create table if not exists calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  caller_id       uuid not null references users(id) on delete cascade,
  callee_id       uuid not null references users(id) on delete cascade,
  kind            text not null check (kind in ('voice','video')),
  status          text not null default 'ringing'
                  check (status in ('ringing','answered','declined','missed','canceled','ended')),
  created_at      timestamptz not null default now(),
  answered_at     timestamptz,
  ended_at        timestamptz
);
create index if not exists calls_caller_idx on calls (caller_id, created_at desc);
create index if not exists calls_callee_idx on calls (callee_id, created_at desc);

-- ───────────── Media terenkripsi (Vercel Blob) ─────────────
create table if not exists media_objects (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references users(id) on delete cascade,
  url        text not null,
  size_bytes int not null,
  purpose    text not null default 'chat' check (purpose in ('chat','status','channel')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists media_owner_idx on media_objects (owner_id);
create index if not exists media_expires_idx on media_objects (expires_at);

-- Untuk database lama (dibuat sebelum fitur video/audio/dokumen/polling/channel): perbarui constraint.
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('text','image','video','audio','document','sticker','poll','vote'));
alter table media_objects drop constraint if exists media_objects_purpose_check;
alter table media_objects add constraint media_objects_purpose_check check (purpose in ('chat','status','channel'));

-- Suara polling = pesan terenkripsi bertipe 'vote' yang menunjuk ke pesan 'poll' lewat reply_to.
create index if not exists messages_votes_idx on messages (reply_to) where kind = 'vote';

-- ───────────── Channel (siaran satu arah, PUBLIK dan tidak dienkripsi E2EE) ─────────────
create table if not exists channels (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users(id) on delete cascade,
  name        text not null,
  handle      text unique check (handle ~ '^[a-z0-9_]{3,30}$'),
  description text not null default '',
  icon_emoji  text not null default '📢',
  icon_color  text not null default '#FF6B6B',
  created_at  timestamptz not null default now()
);
create index if not exists channels_owner_idx on channels (owner_id);

create table if not exists channel_follows (
  channel_id  uuid not null references channels(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  followed_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index if not exists channel_follows_user_idx on channel_follows (user_id);

create table if not exists channel_posts (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  author_id  uuid not null references users(id) on delete cascade,
  kind       text not null check (kind in ('text','image','video','audio','document')),
  body       text not null default '',
  media      jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '180 days'
);
create index if not exists channel_posts_idx on channel_posts (channel_id, created_at desc);

create table if not exists channel_post_reactions (
  post_id uuid not null references channel_posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji   text not null check (char_length(emoji) <= 16),
  primary key (post_id, user_id)
);
