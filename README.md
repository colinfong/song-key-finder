# Song Key Finder

Finds a song's key and chord progression from its audio and lists the chords in that key. It also shows every guitar shape for each chord, plus the matching scale and its dyads across the neck.

All the analysis runs in the browser. The local server adds two things: loading songs from YouTube links, and a library that saves every song you analyse.

## Run it locally

1. Install yt-dlp (one time, only needed for YouTube links):

   ```bash
   brew install yt-dlp
   ```

2. Install dependencies (one time):

   ```bash
   npm install
   ```

3. Start the server from this folder:

   ```bash
   npm start
   ```

4. Open http://localhost:8765. Drop in a file or paste a YouTube link and press **Load song**.

The server listens on this computer only. Use a different port with `PORT=8766 npm start`.

## YouTube links

The server downloads the audio-only stream with yt-dlp to a temporary folder, sends it to the page, and deletes it. Videos over 20 minutes are refused. Use this only for music you have the right to download, since YouTube's terms generally don't allow it.

If YouTube links stop working, update yt-dlp with `brew upgrade yt-dlp`. YouTube changes often, and yt-dlp releases keep up with it.

## Saved songs

Every file or YouTube link you analyse is saved automatically to `songs.db`, a SQLite database in this folder. It appears in the **Saved songs** list, where you can reopen a result without re-analysing, filter by title or key, reload the audio for YouTube songs, or delete a song.

- **What's stored:** the title, the key and its score, the 12 note strengths, the chord chart and the repeating progressions. Audio is never stored.
- **Duplicates:** a song is identified by its YouTube video ID, or by a SHA-256 hash of the file's contents. Analysing the same song again updates its entry instead of adding a new one.
- **Location:** set `DB_PATH=/path/to/file.db` to keep the database somewhere else. `songs.db` is ignored by Git, so your listening history isn't pushed.
- **Backup:** stop the server and copy `songs.db`.
- **Schema changes:** add a numbered file to `migrations/` (for example `002_add_bpm.sql`). The server applies any new ones on start-up.
- **Changing the analysis:** bump `ANALYSIS_VERSION` in `key-finder.html` whenever a change would give different results. Saved results record which version produced them.

If `npm install` hasn't been run, the app still works, just without saving.

### API

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/songs` | Lists saved songs with their newest analysis |
| `POST` | `/api/songs` | Saves a song and its analysis (validated before saving) |
| `GET` | `/api/songs/:id` | Returns one song with its full analysis |
| `DELETE` | `/api/songs/:id` | Deletes a song and its analyses |

## Files

- `key-finder.html`: the whole app (page, audio analysis, music theory). The same file is published as a claude.ai artifact, where the YouTube box and Saved songs stay hidden.
- `server.js`: serves the page and the YouTube and saved-songs endpoints.
- `db.js`: the SQLite database and its queries.
- `migrations/`: the database schema, one numbered file per change.
