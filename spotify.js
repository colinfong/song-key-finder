// Spotify sign-in and playlist import for the local server.
//
// Sign-in uses Spotify's Authorization Code flow with PKCE, so only a Client ID is needed (no secret).
// Tokens stay in this server's memory and are never sent to the page; after a restart, log in again.
// Only song information is imported (title, artist, album, length, playlist order): Spotify doesn't
// offer audio downloads. Imported songs are labelled origin = 'spotify_import' in the database.
const crypto = require('crypto');

const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com';
const API = process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1';
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
const PAGE_SIZE = 50; // Spotify's maximum for these endpoints
const NOT_SHARED = 'Spotify only shares the songs in playlists you own or collaborate on.';

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 300) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null);

// One playlist entry → the fields we keep, or null for podcast episodes and unusable entries
function toSong(entry) {
  const t = entry?.item ?? entry?.track; // `item` replaced `track` in 2026; accept either
  if (!t || (t.type && t.type !== 'track')) return null;
  const ref = t.id || t.uri; // local files have a URI but no ID
  if (!ref) return null;
  return {
    title: clip(t.name) || 'Untitled',
    artist: clip((t.artists || []).map(a => a?.name).filter(Boolean).join(', ')),
    album: clip(t.album?.name),
    duration_sec: Number.isFinite(t.duration_ms) ? Math.round(t.duration_ms / 10) / 100 : null,
    source_ref: String(ref).slice(0, 200),
    added_at: typeof entry.added_at === 'string' ? entry.added_at : null,
  };
}

function createSpotify({ db, port }) {
  const clientId = (process.env.SPOTIFY_CLIENT_ID || '').trim();
  const redirectUri = `http://127.0.0.1:${port}/auth/spotify/callback`;
  const pending = new Map(); // sign-in attempts: state → { verifier, expires }
  let session = null;        // { accessToken, refreshToken, expiresAt, user }
  let job = null;            // the current or last import

  const redirect = (res, location) => { res.writeHead(302, { Location: location }); res.end(); };
  const backToPage = (res, outcome) => redirect(res, `/how-it-works?spotify=${outcome}#spotify`);

  function startLogin(res) {
    if (!clientId) return backToPage(res, 'not_configured');
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(48));
    pending.set(state, { verifier, expires: now + 10 * 60 * 1000 });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    });
    redirect(res, `${ACCOUNTS}/authorize?${q}`);
  }

  async function tokenRequest(params) {
    const r = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw Object.assign(new Error(j.error_description || j.error || `Token request failed (${r.status})`), { status: 401 });
    return j;
  }

  function keepTokens(j) {
    session = {
      ...session,
      accessToken: j.access_token,
      refreshToken: j.refresh_token || session?.refreshToken,
      expiresAt: Date.now() + Math.max(0, (Number(j.expires_in) || 3600) - 60) * 1000,
    };
  }

  async function refresh() {
    if (!session?.refreshToken) throw Object.assign(new Error('Sign-in expired'), { status: 401 });
    keepTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken }));
  }

  async function finishLogin(res, url) {
    const state = url.searchParams.get('state');
    const attempt = state ? pending.get(state) : null;
    if (state) pending.delete(state); // each sign-in link works once
    if (url.searchParams.get('error')) return backToPage(res, 'denied');
    if (!attempt || attempt.expires < Date.now()) return backToPage(res, 'expired');
    try {
      session = null;
      keepTokens(await tokenRequest({
        grant_type: 'authorization_code',
        code: url.searchParams.get('code') || '',
        redirect_uri: redirectUri,
        code_verifier: attempt.verifier,
      }));
      const me = await api('/me');
      session.user = { id: me.id, name: me.display_name || me.id };
      backToPage(res, 'connected');
    } catch (e) {
      session = null;
      console.warn(`Spotify sign-in failed: ${e.message}`);
      backToPage(res, 'failed');
    }
  }

  // Calls the Web API, refreshing the token when it expires and waiting out rate limits
  async function api(pathOrUrl, tries = 0) {
    if (!session) throw Object.assign(new Error('Not logged in to Spotify'), { status: 401 });
    if (Date.now() > session.expiresAt) await refresh();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
    if (!url.startsWith(API)) throw new Error('Refusing to send the Spotify token to another site');
    const r = await fetch(url, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    if (r.status === 429 && tries < 5) {
      await sleep(Math.min(30, Number(r.headers.get('retry-after')) || 2) * 1000);
      return api(pathOrUrl, tries + 1);
    }
    if (r.status === 401 && tries === 0) { await refresh(); return api(pathOrUrl, 1); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error(j.error?.message || `Spotify returned ${r.status}`), { status: r.status });
    }
    return r.json();
  }

  // Follows Spotify's `next` links through every page of a list
  async function allItems(firstPath) {
    const out = [];
    let url = firstPath;
    while (url) {
      const page = await api(url);
      out.push(...(page.items || []));
      url = typeof page.next === 'string' && page.next.startsWith(API) ? page.next : null;
    }
    return out;
  }

  async function runImport() {
    const result = { playlists: 0, entries: 0, skipped: [] };
    job = { running: true, done: 0, total: 0, current: 'Finding your playlists', result, error: null, finishedAt: null };
    try {
      const lists = (await allItems(`/me/playlists?limit=${PAGE_SIZE}`)).filter(p => p && p.id);
      job.total = lists.length + 1;

      job.current = 'Liked Songs';
      const liked = (await allItems(`/me/tracks?limit=${PAGE_SIZE}`)).map(toSong).filter(Boolean);
      db.savePlaylist({ spotify_id: 'liked', name: 'Liked Songs', owner: session.user.name, snapshot_id: null }, liked);
      result.playlists++; result.entries += liked.length; job.done++;

      for (const pl of lists) {
        job.current = pl.name || 'Untitled playlist';
        const mine = pl.owner?.id === session.user.id || pl.collaborative;
        if (!mine) {
          result.skipped.push({ name: job.current, reason: NOT_SHARED });
        } else {
          try {
            const songs = (await allItems(`/playlists/${encodeURIComponent(pl.id)}/items?limit=${PAGE_SIZE}`)).map(toSong).filter(Boolean);
            db.savePlaylist({
              spotify_id: pl.id,
              name: job.current,
              owner: clip(pl.owner?.display_name) || clip(pl.owner?.id),
              snapshot_id: clip(pl.snapshot_id, 200),
            }, songs);
            result.playlists++; result.entries += songs.length;
          } catch (e) {
            if (e.status === 401) throw e;
            result.skipped.push({ name: job.current, reason: e.status === 403 ? NOT_SHARED : e.message });
          }
        }
        job.done++;
      }
    } catch (e) {
      job.error = e.status === 401 ? 'Your Spotify login expired. Log in again, then import.' : `The import stopped: ${e.message}`;
      if (e.status === 401) session = null;
    }
    job.running = false;
    job.current = null;
    job.finishedAt = new Date().toISOString();
  }

  function status() {
    return {
      configured: !!clientId,
      library: !!db,
      redirectUri,
      connected: !!session?.user,
      user: session?.user?.name ?? null,
      import: job,
      counts: db ? db.counts() : {},
    };
  }

  // Returns true when it handled the request
  async function handle(req, res, pathname, url, sendJson) {
    const { method } = req;
    if (pathname === '/auth/spotify/login' && method === 'GET') { startLogin(res); return true; }
    if (pathname === '/auth/spotify/callback' && method === 'GET') { await finishLogin(res, url); return true; }
    if (!pathname.startsWith('/api/spotify/')) return false;

    if (pathname === '/api/spotify/status' && method === 'GET') sendJson(res, 200, status());
    else if (pathname === '/api/spotify/logout' && method === 'POST') { session = null; sendJson(res, 200, { ok: true }); }
    else if (pathname === '/api/spotify/import' && method === 'POST') {
      if (!db) sendJson(res, 503, { error: 'Saving is off. Run "npm install", then restart the server.' });
      else if (!session) sendJson(res, 401, { error: 'Log in to Spotify first.' });
      else if (job?.running) sendJson(res, 409, { error: 'An import is already running.' });
      else { runImport(); sendJson(res, 202, { started: true }); }
    } else if (pathname === '/api/spotify/playlists' && method === 'GET') {
      sendJson(res, 200, { playlists: db ? db.listPlaylists() : [] });
    } else {
      const m = /^\/api\/spotify\/playlists\/(\d+)\/songs$/.exec(pathname);
      if (m && method === 'GET' && db) sendJson(res, 200, { songs: db.playlistSongs(Number(m[1])) });
      else sendJson(res, 404, { error: 'Not found' });
    }
    return true;
  }

  return { handle };
}

module.exports = { createSpotify, toSong };
