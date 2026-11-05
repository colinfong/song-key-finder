# CLAUDE.md

Notes for Claude Code sessions working on Song Key Finder. The README covers setup for people; this file covers how the project is built, the decisions behind it, and what to watch out for. Personal notes, if any, go in `CLAUDE.local.md`, which Git ignores.

## What the app does

A browser app that takes a song (audio file or YouTube link) and:

1. Detects its **key** (Krumhansl–Schmuckler profiles over a 12-note chromagram).
2. Lists the **chords in the key**, plus common borrowed chords.
3. Estimates the **chord progression** over time and finds its repeating loops.
4. Shows every **guitar voicing** of a chord across the neck (standard tuning).
5. Shows the **scale** on the selected chord's root and its **dyads** on a string pair.
6. **Saves** every analysed song to a local SQLite library (Saved songs drawer).
7. **Imports Spotify playlists** (song info only) into the same database, labelled separately.

## Files

| File | Role |
|---|---|
| `key-finder.html` | The whole main app: page, audio analysis, music theory, UI. Served at `/`. |
| `how-it-works.html` | Second page: explanation of the analysis plus the Spotify import UI. Served at `/how-it-works`. |
| `server.js` | Local Node server: serves pages, YouTube audio (`/api/youtube`), saved songs (`/api/songs`), Spotify routes. Loads `.env`. |
| `db.js` | SQLite (better-sqlite3) access and migrations runner. |
| `spotify.js` | Spotify PKCE login, token refresh, playlist import job. |
| `migrations/NNN_*.sql` | Schema, applied in order on start-up and recorded in `schema_migrations`. |
| `.env.example` | Template for `.env` (`SPOTIFY_CLIENT_ID`). `.env` itself is gitignored. |

Pages are written **without** `<!doctype>/<html>/<head>/<body>`: the claude.ai artifact publisher adds that skeleton, and `server.js` `pageHtml()` adds the same one locally.

## Commands

```bash
npm install            # once; installs better-sqlite3
npm start              # http://localhost:8765 (PORT=8766 npm start for another port)
brew install yt-dlp    # needed for YouTube links
```

Syntax checks used throughout (there is no test suite):

```bash
node --check server.js && node --check db.js && node --check spotify.js
node -e 'const h=require("fs").readFileSync("key-finder.html","utf8");const s=[...h.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);new Function(s[0]+"\n"+s[1]);console.log("ok")'
```

`key-finder.html` has two scripts: `<script id="theory">` holds pure functions (music theory, key ranking, chord detection, loop finding, voicings, scales, dyads) and exports them via `module.exports` when run under Node, so they can be tested by extracting that block and `require`-ing it. The second script is DOM/audio code.

## How the analysis works (key-finder.html)

- Decode with `OfflineAudioContext(1, 1, 22050).decodeAudioData` (resamples to 22,050 Hz), mix to mono, cap at 10 minutes.
- `chromaFrom`: Hann-windowed 8192-sample frames, hop 4096 (~0.19 s), radix-2 FFT, bins 55 Hz–2.1 kHz mapped to pitch classes with cos² weighting. Returns per-frame chroma, energies and a whole-song average.
- `rankKeys`: Pearson correlation of the average against rotated K–S major/minor profiles for all 24 keys.
- `detectChords`: per-frame Pearson match against 24 major/minor triad templates plus a no-chord state, a key-membership bonus, then Viterbi smoothing with a switch penalty. Times are offset by half a window. `mergeShort` folds blips under 0.55 s (no-chord gaps need twice that).
- `findLoops`: repeated n-grams (2–8 chords) on the collapsed sequence, rotations treated as one loop, scored by `(count - 1) * length`, filtered so later loops aren't just parts of an earlier loop played round.
- Chord states: 0–11 major on that root, 12–23 minor, 24 = no chord. Names and Roman numerals are always computed from the selected key at render time, never stored.
- Spelling is letter-based (`spell(letter, pc)`), so keys like F♯ major correctly spell E♯.
- `ANALYSIS_VERSION` (currently 1) must be bumped when a change would alter results; saved analyses record it.

The demo track (G–D–Em–C, synthesized on load) should detect as **G major** with main progression **I – V – vi – IV ×3**. Use it as a quick regression check.

## Database (songs.db)

- `songs`: one row per song. `origin` labels it: `key_detection` (file/YouTube, analysed) or `spotify_import` (Spotify, info only). A CHECK keeps `source_type = 'spotify'` and `origin = 'spotify_import'` in step. Unique on `(source_type, source_ref)`: YouTube video ID, SHA-256 of the file bytes, or Spotify track ID (URI for local files).
- `analyses`: one per song per `analysis_version`; JSON columns for chroma, segments, loops. The key ranking is rebuilt from chroma on load, not stored.
- `playlists` / `playlist_songs`: Spotify playlists in order; Liked Songs uses `spotify_id = 'liked'`. Re-import replaces a playlist's contents.
- Audio is never stored.
- Foreign keys are **off while migrations run** (a table rebuild would otherwise cascade-delete analyses), checked with `foreign_key_check`, then turned on.
- New schema change = new numbered file in `migrations/`. SQLite can't alter a CHECK in place; rebuild the table as in `002_spotify.sql`.

## Server rules

- Listens on `127.0.0.1` only. `fromThisComputer()` rejects requests whose Host isn't `localhost:PORT`/`127.0.0.1:PORT` and non-GET requests from foreign Origins (DNS-rebinding and cross-site protection). Keep it.
- Everything the page sends to `/api/songs` is validated in `validateAnalysis()` before it reaches the database; queries are parameterised.
- If better-sqlite3 isn't installed, the server still runs with the library off (`/api/health` reports `library: false`).
- yt-dlp runs with an argument array (no shell), `--` before the URL, only for YouTube hosts, 20-minute limit, temp folder deleted after sending.

## Spotify (spotify.js)

- Authorization Code + PKCE; only `SPOTIFY_CLIENT_ID` is needed. Tokens live in server memory and are only sent to the API base; log in again after a restart.
- Redirect URI must be `http://127.0.0.1:PORT/auth/spotify/callback`. Spotify rejects `localhost`.
- Current API (checked 2026-10): playlist songs come from `GET /playlists/{id}/items` (`/tracks` is deprecated) and each entry's song is under `item` (old `track` still accepted as fallback). `GET /me/playlists` and `GET /me/tracks` (Liked Songs) page at 50.
- Spotify only returns songs for playlists the logged-in account **owns or collaborates on**; followed playlists are skipped (pre-filtered by owner, and 403s are reported as skipped).
- New Spotify apps can't read audio features, so imported songs have no key. Dev-mode apps only allow allowlisted users.
- `SPOTIFY_ACCOUNTS_BASE` / `SPOTIFY_API_BASE` env vars exist so the flow can be tested against a mock server that imitates `/authorize`, `/api/token` and the Web API endpoints above. No mock is included in the repo.

## Hosted version (claude.ai artifact)

`key-finder.html` can also be published on its own as a claude.ai artifact, which runs with file upload only.

- The artifact sandbox blocks network calls, so local-only features (YouTube box, Saved songs drawer, page links in the top bar) are hidden unless `location.hostname` is `localhost`/`127.0.0.1` and `/api/health` answers.
- Publish from `main`, so the hosted page matches the released code.
- Page design rules from the artifact contract: colours as tokens on `:root` with dark-mode overrides under `@media (prefers-color-scheme: dark)` (guarded `:root:not([data-theme="light"])`) and `:root[data-theme="dark"]`; explicit `body` background; side gutters `max(16px, env(safe-area-inset-*))`; no horizontal scroll at phone width.

## Gotchas

- **Copying the database:** copy `songs.db` together with `songs.db-wal` and `songs.db-shm`, or recent changes are lost (WAL mode).
- **Testing against real data:** point the server at a copy, e.g. `DB_PATH=test-copy.db PORT=8799 node server.js`; never test destructive changes on the real `songs.db`.
- **Port in use:** the server prints a clear message on `EADDRINUSE`; a copy of the server already running in the background is the usual cause.
- **Browser pane:** CSS transitions run slowly while the pane is in the background, so measure the drawer after a delay or screenshot twice. Navigating to the same URL with only a different `#hash` doesn't reload; call `location.reload()`.
- **Top bar styles** are duplicated in both pages (so each stands alone). Keep them in step; the bar must be the same height on both pages (min-height 64px, brand min-height 44px, link line-height 1.5).
- **YouTube:** if links fail, update yt-dlp first (`brew upgrade yt-dlp`); YouTube changes often.
- **Never commit** `.env`, `songs.db*`, `node_modules/` or `.claude/`; `.gitignore` covers them.

## Possible next steps

- Key-detect Spotify songs (e.g. by finding them on YouTube) and link the analysis to the Spotify song row.
- Remove playlists that were deleted on Spotify during re-import (currently kept).
