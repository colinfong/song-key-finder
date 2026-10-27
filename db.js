// SQLite storage for analysed songs. Schema changes live in migrations/ as numbered .sql files,
// applied in order on start-up and recorded in schema_migrations.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS = path.join(__dirname, 'migrations');

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all());
  const files = fs.readdirSync(MIGRATIONS)
    .map(f => ({ f, m: /^(\d+)_.+\.sql$/.exec(f) }))
    .filter(x => x.m)
    .map(x => ({ file: x.f, version: Number(x.m[1]) }))
    .sort((a, b) => a.version - b.version);
  for (const { file, version } of files) {
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    })();
  }
}

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const upsertSong = db.prepare(`
    INSERT INTO songs (title, source_type, source_ref, duration_sec)
    VALUES (@title, @source_type, @source_ref, @duration_sec)
    ON CONFLICT (source_type, source_ref) DO UPDATE SET title = excluded.title, duration_sec = excluded.duration_sec
    RETURNING id`);
  const upsertAnalysis = db.prepare(`
    INSERT INTO analyses (song_id, analysis_version, key_tonic, key_mode, key_score, confidence, chroma_json, segments_json, loops_json)
    VALUES (@song_id, @analysis_version, @key_tonic, @key_mode, @key_score, @confidence, @chroma_json, @segments_json, @loops_json)
    ON CONFLICT (song_id, analysis_version) DO UPDATE SET
      key_tonic = excluded.key_tonic, key_mode = excluded.key_mode, key_score = excluded.key_score,
      confidence = excluded.confidence, chroma_json = excluded.chroma_json,
      segments_json = excluded.segments_json, loops_json = excluded.loops_json, created_at = datetime('now')
    RETURNING id`);
  // Each song with its newest analysis
  const latest = `
    SELECT s.id, s.title, s.source_type, s.source_ref, s.duration_sec,
           a.id AS analysis_id, a.analysis_version, a.key_tonic, a.key_mode, a.key_score, a.confidence,
           a.chroma_json, a.segments_json, a.loops_json, a.created_at AS analyzed_at
    FROM songs s
    JOIN analyses a ON a.id = (
      SELECT id FROM analyses WHERE song_id = s.id ORDER BY analysis_version DESC, created_at DESC LIMIT 1)`;
  const listStmt = db.prepare(`${latest} ORDER BY a.created_at DESC, s.id DESC`);
  const getStmt = db.prepare(`${latest} WHERE s.id = ?`);
  const deleteStmt = db.prepare('DELETE FROM songs WHERE id = ?');

  return {
    // Saves a song and its analysis together, so a failure can't leave one without the other
    save: db.transaction(r => {
      const songId = upsertSong.get({
        title: r.title, source_type: r.source_type, source_ref: r.source_ref, duration_sec: r.duration_sec,
      }).id;
      const analysisId = upsertAnalysis.get({
        song_id: songId,
        analysis_version: r.analysis_version,
        key_tonic: r.key_tonic,
        key_mode: r.key_mode,
        key_score: r.key_score,
        confidence: r.confidence,
        chroma_json: JSON.stringify(r.chroma),
        segments_json: JSON.stringify(r.segments),
        loops_json: JSON.stringify(r.loops),
      }).id;
      return { song_id: songId, analysis_id: analysisId };
    }),
    list: () => listStmt.all().map(row => {
      const loops = JSON.parse(row.loops_json);
      return {
        id: row.id, title: row.title, source_type: row.source_type, source_ref: row.source_ref,
        duration_sec: row.duration_sec, key_tonic: row.key_tonic, key_mode: row.key_mode,
        confidence: row.confidence, analyzed_at: row.analyzed_at,
        main_loop: loops[0]?.pattern ?? null,
      };
    }),
    get: id => {
      const row = getStmt.get(id);
      if (!row) return null;
      const { chroma_json, segments_json, loops_json, ...rest } = row;
      return { ...rest, chroma: JSON.parse(chroma_json), segments: JSON.parse(segments_json), loops: JSON.parse(loops_json) };
    },
    remove: id => deleteStmt.run(id).changes > 0,
    close: () => db.close(),
  };
}

module.exports = { openDb };
