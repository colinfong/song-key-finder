// Local server for Song Key Finder: serves the page and fetches YouTube audio with yt-dlp.
// Run with `node server.js`, then open http://localhost:8765
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8765;
const HOST = '127.0.0.1'; // only reachable from this computer
// URL path → page file
const PAGES = {
  '/': 'key-finder.html',
  '/index.html': 'key-finder.html',
  '/how-it-works': 'how-it-works.html',
  '/how-it-works.html': 'how-it-works.html',
};
const MAX_SECONDS = 20 * 60;
const MAX_BYTES = 80 * 1024 * 1024;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'songs.db');

// The saved-songs library is optional: without the SQLite package the app still runs, just without saving
let db = null;
try {
  db = require('./db').openDb(DB_PATH);
} catch (e) {
  console.warn(`Saved songs are off (${e.code === 'MODULE_NOT_FOUND' ? 'run "npm install" to enable them' : e.message}).`);
}

// The publish step wraps the page in a document skeleton; locally we add it ourselves
function pageHtml(file) {
  const body = fs.readFileSync(path.join(__dirname, file), 'utf8');
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
    + 'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
    + '</head><body>' + body + '</body></html>';
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function parseYouTubeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) return null;
  return u.toString();
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) { reject(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Downloads the best audio-only stream to a temp folder. No ffmpeg needed: the file is
// served as YouTube provides it (usually M4A/AAC), which browsers can decode directly.
function downloadAudio(url) {
  return new Promise((resolve, reject) => {
    // realpath so the path yt-dlp prints matches (macOS temp folders sit behind a symlink)
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keyfinder-')));
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--max-filesize', String(MAX_BYTES),
      '--match-filter', `duration < ${MAX_SECONDS}`,
      '-P', dir, '-o', 'audio.%(ext)s',
      '--print', '%(id)s\t%(title)s', '--print', 'after_move:filepath', '--no-simulate',
      '--', url,
    ];
    let child;
    try { child = spawn('yt-dlp', args); } catch (e) { return reject(Object.assign(e, { dir })); }
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(Object.assign(e, { dir })));
    child.on('close', code => {
      const lines = out.trim().split('\n').filter(Boolean);
      const file = lines.find(l => l.startsWith(dir));
      if (code === 0 && file && fs.existsSync(file)) {
        const [id, ...title] = (lines.find(l => l !== file) || '').split('\t');
        resolve({ dir, file, id, title: title.join('\t') || 'YouTube audio' });
      } else {
        const filtered = !file && code === 0;
        reject(Object.assign(new Error(filtered ? 'too_long' : (err.trim().split('\n').pop() || `yt-dlp exited with code ${code}`)), { dir }));
      }
    });
  });
}

async function handleYouTube(req, res) {
  let url;
  try { url = parseYouTubeUrl(JSON.parse(await readBody(req)).url); } catch { url = null; }
  if (!url) return sendJson(res, 400, { error: 'That doesn\'t look like a YouTube link. Paste a link like https://www.youtube.com/watch?v=…' });

  let result;
  try {
    result = await downloadAudio(url);
  } catch (e) {
    if (e.dir) fs.rmSync(e.dir, { recursive: true, force: true });
    if (e.code === 'ENOENT') return sendJson(res, 500, { error: 'yt-dlp isn\'t installed. Install it with "brew install yt-dlp", then try again.' });
    if (e.message === 'too_long') return sendJson(res, 400, { error: `That video is longer than ${MAX_SECONDS / 60} minutes or its audio is over ${MAX_BYTES / 1024 / 1024} MB. Try a single song.` });
    return sendJson(res, 502, { error: `Couldn't get the audio: ${e.message.replace(/^ERROR:\s*/, '')}` });
  }

  const ext = path.extname(result.file).slice(1);
  const type = { m4a: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', mp3: 'audio/mpeg' }[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': fs.statSync(result.file).size,
    'X-Title': encodeURIComponent(result.title),
    'X-Video-Id': result.id || '',
  });
  const stream = fs.createReadStream(result.file);
  stream.pipe(res);
  const cleanup = () => fs.rmSync(result.dir, { recursive: true, force: true });
  stream.on('close', cleanup);
  stream.on('error', cleanup);
}

// ---------- Saved songs ----------
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const round2 = v => Math.round(v * 100) / 100;

// Checks an analysis sent by the page and returns a clean copy, or a message saying what's wrong.
// The page is not trusted: everything is checked before it reaches the database.
function validateAnalysis(b) {
  if (!b || typeof b !== 'object') return { error: 'Expected a JSON object.' };
  if (!['file', 'youtube'].includes(b.source_type)) return { error: 'source_type must be "file" or "youtube".' };
  const refOk = b.source_type === 'youtube' ? /^[A-Za-z0-9_-]{11}$/.test(b.source_ref) : /^[a-f0-9]{64}$/.test(b.source_ref);
  if (!refOk) return { error: b.source_type === 'youtube' ? 'source_ref must be an 11-character YouTube video ID.' : 'source_ref must be a SHA-256 hash in hex.' };
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 300) return { error: 'title must be 1 to 300 characters.' };
  if (!isNum(b.duration_sec, 0, 36000)) return { error: 'duration_sec must be between 0 and 36000.' };
  if (!isInt(b.analysis_version, 1, 1000)) return { error: 'analysis_version must be a whole number from 1.' };
  if (!isInt(b.key_tonic, 0, 11)) return { error: 'key_tonic must be 0 to 11.' };
  if (!['major', 'minor'].includes(b.key_mode)) return { error: 'key_mode must be "major" or "minor".' };
  if (!isNum(b.key_score, -1, 1)) return { error: 'key_score must be between -1 and 1.' };
  if (!['strong', 'moderate', 'weak'].includes(b.confidence)) return { error: 'confidence must be strong, moderate or weak.' };
  if (!Array.isArray(b.chroma) || b.chroma.length !== 12 || !b.chroma.every(v => isNum(v, 0, 1))) return { error: 'chroma must be 12 numbers from 0 to 1.' };
  if (!Array.isArray(b.segments) || b.segments.length < 1 || b.segments.length > 5000) return { error: 'segments must have 1 to 5000 entries.' };
  let prevStart = 0;
  for (const s of b.segments) {
    if (!s || !isInt(s.state, 0, 24) || !isNum(s.start, 0, 36000) || !isNum(s.end, 0, 36000) || s.end <= s.start || s.start < prevStart) {
      return { error: 'Each segment needs a state from 0 to 24 and increasing start and end times.' };
    }
    prevStart = s.start;
  }
  if (!Array.isArray(b.loops) || b.loops.length > 3) return { error: 'loops must have at most 3 entries.' };
  for (const l of b.loops) {
    if (!l || !Array.isArray(l.pattern) || l.pattern.length < 2 || l.pattern.length > 8 || !l.pattern.every(s => isInt(s, 0, 23)) || !isInt(l.count, 2, 10000)) {
      return { error: 'Each loop needs a pattern of 2 to 8 chord states and a count of at least 2.' };
    }
  }
  return {
    value: {
      source_type: b.source_type, source_ref: b.source_ref, title, duration_sec: round2(b.duration_sec),
      analysis_version: b.analysis_version, key_tonic: b.key_tonic, key_mode: b.key_mode,
      key_score: Math.round(b.key_score * 1e4) / 1e4, confidence: b.confidence,
      chroma: b.chroma.map(v => Math.round(v * 1e4) / 1e4),
      segments: b.segments.map(s => ({ state: s.state, start: round2(s.start), end: round2(s.end) })),
      loops: b.loops.map(l => ({ pattern: l.pattern, count: l.count })),
    },
  };
}

async function handleSongs(req, res, pathname) {
  if (!db) return sendJson(res, 503, { error: 'Saved songs are off. Run "npm install" in the project folder, then restart the server.' });
  const idMatch = /^\/api\/songs\/(\d+)$/.exec(pathname);
  if (pathname === '/api/songs' && req.method === 'GET') return sendJson(res, 200, { songs: db.list() });
  if (pathname === '/api/songs' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 1_000_000)); } catch { return sendJson(res, 400, { error: 'The request wasn\'t valid JSON or was too large.' }); }
    const { value, error } = validateAnalysis(body);
    if (error) return sendJson(res, 400, { error });
    return sendJson(res, 201, db.save(value));
  }
  if (idMatch && req.method === 'GET') {
    const song = db.get(Number(idMatch[1]));
    return song ? sendJson(res, 200, song) : sendJson(res, 404, { error: 'That song isn\'t in your library.' });
  }
  if (idMatch && req.method === 'DELETE') {
    return db.remove(Number(idMatch[1])) ? sendJson(res, 200, { deleted: true }) : sendJson(res, 404, { error: 'That song isn\'t in your library.' });
  }
  sendJson(res, 405, { error: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && Object.hasOwn(PAGES, pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageHtml(PAGES[pathname]));
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, library: !!db });
    }
    if (req.method === 'POST' && pathname === '/api/youtube') {
      return await handleYouTube(req, res);
    }
    if (pathname === '/api/songs' || pathname.startsWith('/api/songs/')) {
      return await handleSongs(req, res, pathname);
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use, probably by another copy of this server.`);
  console.error(`If it's already running, just open http://localhost:${PORT}. Otherwise pick another port: PORT=8766 npm start`);
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`Song Key Finder running at http://localhost:${PORT}`));
