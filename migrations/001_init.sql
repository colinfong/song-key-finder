-- Songs are what was analysed; analyses are the results, one per song per analysis version.
-- Audio is never stored: a song can be re-analysed from its file or YouTube link.

CREATE TABLE songs (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  source_type  TEXT NOT NULL CHECK (source_type IN ('file', 'youtube')),
  source_ref   TEXT NOT NULL,          -- YouTube video ID, or SHA-256 of the file's bytes
  duration_sec REAL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, source_ref)
);

CREATE TABLE analyses (
  id               INTEGER PRIMARY KEY,
  song_id          INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  analysis_version INTEGER NOT NULL,   -- bumped when the detection code changes
  key_tonic        INTEGER NOT NULL CHECK (key_tonic BETWEEN 0 AND 11),  -- C = 0
  key_mode         TEXT NOT NULL CHECK (key_mode IN ('major', 'minor')),
  key_score        REAL NOT NULL,      -- correlation with the key profile
  confidence       TEXT NOT NULL CHECK (confidence IN ('strong', 'moderate', 'weak')),
  chroma_json      TEXT NOT NULL,      -- [12 note strengths]; the key ranking is recomputed from it
  segments_json    TEXT NOT NULL,      -- [{state, start, end}]; state 0-11 major, 12-23 minor, 24 no chord
  loops_json       TEXT NOT NULL,      -- [{pattern: [state, ...], count}]
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (song_id, analysis_version)
);

CREATE INDEX analyses_by_key ON analyses (key_tonic, key_mode);
