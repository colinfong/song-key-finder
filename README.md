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

## Spotify import

The **How it works** page can log in to your Spotify account and import every playlist you own or collaborate on, plus your Liked Songs, into the same database.

- **Only song information is imported:** title, artist, album, length and playlist order. Spotify doesn't allow audio downloads.
- **Labels:** every song has an `origin`. `key_detection` means it was analysed by the key finder; `spotify_import` means it came from Spotify. The database rejects a song whose label doesn't match its source, and Spotify songs don't appear in the Saved songs drawer.
- **Playlists you only follow** (including Spotify's own) are listed as skipped, because Spotify only shares the songs in playlists you own or collaborate on.
- **Importing again** updates each playlist to match Spotify, without duplicating songs. A song in several playlists is stored once.
- **Login** uses Spotify's PKCE flow, so no client secret is needed. Tokens stay in the server's memory and never reach the page; log in again after restarting the server.

To set it up once:

1. Create an app at https://developer.spotify.com/dashboard.
2. Add the Redirect URI `http://127.0.0.1:8765/auth/spotify/callback`, using your port if you run on another one. Spotify doesn't accept `localhost` here.
3. Tick **Web API**, save, and copy the Client ID.
4. Copy `.env.example` to `.env` and paste the Client ID after `SPOTIFY_CLIENT_ID=`. `.env` is ignored by Git.
5. Restart the server, open the How it works page, and press **Log in with Spotify**.

Spotify apps start in development mode, which only lets accounts you add under the app's **User Management** log in.

### API

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/songs` | Lists saved songs with their newest analysis |
| `POST` | `/api/songs` | Saves a song and its analysis (validated before saving) |
| `GET` | `/api/songs/:id` | Returns one song with its full analysis |
| `DELETE` | `/api/songs/:id` | Deletes a song and its analyses |
| `GET` | `/auth/spotify/login` | Starts the Spotify login |
| `GET` | `/api/spotify/status` | Login state, import progress and song counts by label |
| `POST` | `/api/spotify/import` | Imports all playlists and Liked Songs |
| `POST` | `/api/spotify/logout` | Forgets the Spotify login (imported songs stay) |
| `GET` | `/api/spotify/playlists` | Lists imported playlists |
| `GET` | `/api/spotify/playlists/:id/songs` | Lists one playlist's songs in order |

The server only accepts requests from its own pages: other hosts and other websites' pages are refused.

## Files

- `key-finder.html`: the whole app (page, audio analysis, music theory), served at `/`. The same file is published as a claude.ai artifact, where the YouTube box, Saved songs and page links stay hidden.
- `how-it-works.html`: a second page explaining the analysis, served at `/how-it-works`. Both pages share the top bar; its styles are copied in each file, so keep them in step.
- `server.js`: serves the page and the YouTube and saved-songs endpoints.
- `db.js`: the SQLite database and its queries.
- `spotify.js`: Spotify login and playlist import.
- `.env.example`: a template for `.env`, which holds your Spotify Client ID.
- `migrations/`: the database schema, one numbered file per change.
