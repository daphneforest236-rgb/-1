-- Phase 1 only: website users, sessions, and one observable per-user test item.
-- Every user-owned row has user_id and API queries are always scoped to it.
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx ON app_sessions(user_id);

CREATE TABLE IF NOT EXISTS user_test_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_test_items_user_id_idx ON user_test_items(user_id, created_at DESC);

-- Phase 2: each row belongs to exactly one website user.  We intentionally
-- keep the song metadata in this table for now: there is no global catalogue
-- or NetEase integration in this phase.
CREATE TABLE IF NOT EXISTS user_library_tracks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  source_song_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT '中文',
  cover TEXT NOT NULL DEFAULT 'a',
  recent INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  pref TEXT NOT NULL DEFAULT '正常',
  black BOOLEAN NOT NULL DEFAULT false,
  manual BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_song_id)
);
CREATE INDEX IF NOT EXISTS user_library_tracks_user_id_idx ON user_library_tracks(user_id, created_at DESC);
