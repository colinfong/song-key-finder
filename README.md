# Song Key Finder

Finds a song's key from its audio and lists the chords in that key. It also shows every guitar shape for each chord, plus the matching scale and its dyads across the neck.

All the analysis runs in the browser. The local server is only needed for YouTube links.

## Run it locally (with YouTube links)

1. Install yt-dlp (one time):

   ```bash
   brew install yt-dlp
   ```

2. Start the server from this folder:

   ```bash
   npm start
   ```

3. Open http://localhost:8765, paste a YouTube link, and press **Load song**.

The server listens on this computer only. It downloads the audio-only stream to a temporary folder, sends it to the page, and deletes it. Videos over 20 minutes are refused. Use this only for music you have the right to download, since YouTube's terms generally don't allow it.

If YouTube links stop working, update yt-dlp with `brew upgrade yt-dlp`. YouTube changes often, and yt-dlp releases keep up with it.

## Files

- `key-finder.html`: the whole app (page, audio analysis, music theory). The same file is published as a claude.ai artifact, where the YouTube box stays hidden.
- `server.js`: serves the page and the `/api/youtube` endpoint. It uses only built-in Node modules, so there's nothing to `npm install`.
