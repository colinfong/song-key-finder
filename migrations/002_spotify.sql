-- Labels every song with where it came from, and adds Spotify playlists.
--   origin = 'key_detection'  : analysed by the key finder (file or YouTube), has rows in analyses
--   origin = 'spotify_import' : imported from Spotify (song information only, no audio, no analysis)
-- SQLite can't change a CHECK constraint in place, so songs is rebuilt and its rows copied across.
-- Foreign keys are switched off while migrations run, so analyses keep pointing at the same song ids.

CREATE TABLE songs_new (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  artist       TEXT,
  album        TEXT,
  source_type  TEXT NOT NULL CHECK (source_type IN ('file', 'youtube', 'spotify')),
  source_ref   TEXT NOT NULL,   -- YouTube video ID, SHA-256 of a file, or Spotify track ID
  duration_sec REAL,
  origin       TEXT NOT NULL DEFAULT 'key_detection' CHECK (origin IN ('key_detection', 'spotify_import')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_ref),
  CHECK ((source_type = 'spotify') = (origin = 'spotify_import'))
);

INSERT INTO songs_new (id, title, source_type, source_ref, duration_sec, origin, created_at)
  SELECT id, title, source_type, source_ref, duration_sec, 'key_detection', created_at FROM songs;

DROP TABLE songs;
ALTER TABLE songs_new RENAME TO songs;
CREATE INDEX songs_by_origin ON songs (origin);

CREATE TABLE playlists (
  id          INTEGER PRIMARY KEY,
  spotify_id  TEXT NOT NULL UNIQUE,   -- 'liked' for Liked Songs
  name        TEXT NOT NULL,
  owner       TEXT,
  snapshot_id TEXT,                   -- Spotify's version marker for the playlist
  track_count INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A song can be in many playlists, and a playlist can hold the same song twice
CREATE TABLE playlist_songs (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  added_at    TEXT,
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX playlist_songs_by_song ON playlist_songs (song_id);
