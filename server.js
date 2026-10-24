// Local server for Song Key Finder: serves the page and fetches YouTube audio with yt-dlp.
// Run with `node server.js`, then open http://localhost:8765
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8765;
const HOST = '127.0.0.1'; // only reachable from this computer
const PAGE = path.join(__dirname, 'key-finder.html');
const MAX_SECONDS = 20 * 60;
const MAX_BYTES = 80 * 1024 * 1024;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

// The publish step wraps the page in a document skeleton; locally we add it ourselves
function pageHtml() {
  const body = fs.readFileSync(PAGE, 'utf8');
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
      '--print', 'title', '--print', 'after_move:filepath', '--no-simulate',
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
        resolve({ dir, file, title: lines.find(l => l !== file) || 'YouTube audio' });
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
  });
  const stream = fs.createReadStream(result.file);
  stream.pipe(res);
  const cleanup = () => fs.rmSync(result.dir, { recursive: true, force: true });
  stream.on('close', cleanup);
  stream.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageHtml());
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/youtube') {
      return await handleYouTube(req, res);
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
