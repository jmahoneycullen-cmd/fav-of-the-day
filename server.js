// Fav of the Day - tiny zero-dependency GIF tier board.
// Run: node server.js
// Env: PORT, DATA_DIR (where data.json + uploads/ live), GIPHY_API_KEY, ADMIN_PASSCODE, DAILY_ADD_LIMIT
// Locally, giphyApiKey / adminPasscode can also go in config.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = process.env.PORT || 8090;
const DATA_DIR = process.env.DATA_DIR || ROOT;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TIERS = ['S', 'A', 'B', 'C', 'D', 'E', 'F'];
const MAX_UPLOAD = 5 * 1024 * 1024;
const DAILY_ADD_LIMIT = Number(process.env.DAILY_ADD_LIMIT) || 20;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || fileConfig.adminPasscode || '';

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function isAdmin(req) {
  const given = req.headers['x-admin'] || '';
  return !!ADMIN_PASSCODE && given.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(hash(given)), Buffer.from(hash(ADMIN_PASSCODE)));
}
// Each browser makes a random token; we keep only its hash, so "mine" can be proven without accounts.
function ownerHash(req) {
  const t = String(req.headers['x-owner'] || '');
  return /^[a-f0-9-]{20,64}$/i.test(t) ? hash(t) : null;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}
const addCounts = new Map(); // "day|ip" -> count, reset as days roll over
function overLimit(req) {
  const key = new Date().toISOString().slice(0, 10) + '|' + clientIp(req);
  if (addCounts.size > 5000) addCounts.clear();
  const n = (addCounts.get(key) || 0) + 1;
  addCounts.set(key, n);
  return n > DAILY_ADD_LIMIT;
}
// What the browser gets: never the owner hash, just whether it's yours.
const publicGif = (g, req) => {
  const { owner, ...rest } = g;
  return { ...rest, mine: !!owner && owner === ownerHash(req) };
};

function giphyKey() {
  return process.env.GIPHY_API_KEY || fileConfig.giphyApiKey || '';
}

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { gifs: [] }; }
}
function save(db) {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req, limit = MAX_UPLOAD * 1.4) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('too_big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

// Turn any Giphy link (page, embed, media, gph.is short link) into a direct GIF URL.
async function resolveGiphy(input) {
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.hostname === 'gph.is') {
    const r = await fetch(url, { redirect: 'manual' });
    const loc = r.headers.get('location');
    return loc ? resolveGiphy(loc) : null;
  }
  if (!/(^|\.)giphy\.com$/.test(url.hostname)) {
    // Allow any other direct image link too.
    return /\.(gif|webp|png|jpe?g)$/i.test(url.pathname) && url.protocol === 'https:' ? url.href : null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  let id = null;
  const mediaIdx = parts.indexOf('media');
  if (mediaIdx !== -1) {
    // /media/ID/giphy.gif or /media/v1.xxxx/ID/giphy.gif
    id = parts[mediaIdx + 1]?.startsWith('v1.') ? parts[mediaIdx + 2] : parts[mediaIdx + 1];
  } else if (parts[0] === 'gifs' || parts[0] === 'stickers' || parts[0] === 'embed' || parts[0] === 'clips') {
    const last = parts[parts.length - 1];
    id = last.includes('-') ? last.split('-').pop() : last;
  }
  if (!id || !/^[A-Za-z0-9]+$/.test(id)) return null;
  return `https://media.giphy.com/media/${id}/giphy.gif`;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.gif': 'image/gif', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': file.startsWith(UPLOAD_DIR) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') return serveStatic(res, path.join(ROOT, 'index.html'));
    if (req.method === 'GET' && p.startsWith('/uploads/')) {
      const file = path.join(UPLOAD_DIR, path.basename(p));
      return serveStatic(res, file);
    }

    if (req.method === 'GET' && p === '/api/config') return send(res, 200, { search: !!giphyKey(), tiers: TIERS, maxUploadMb: MAX_UPLOAD / 1048576 });
    if (req.method === 'GET' && p === '/api/admin') return send(res, isAdmin(req) ? 200 : 403, { admin: isAdmin(req) });

    if (req.method === 'GET' && p === '/api/gifs') {
      const day = url.searchParams.get('day');
      const gifs = load().gifs.filter(g => !day || g.day === day).map(g => publicGif(g, req));
      return send(res, 200, { gifs });
    }

    if (req.method === 'GET' && p === '/api/search') {
      const key = giphyKey();
      if (!key) return send(res, 400, { error: 'Search needs a Giphy API key in config.json.' });
      const q = (url.searchParams.get('q') || '').slice(0, 50);
      const endpoint = q
        ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=24&rating=pg-13`;
      const r = await fetch(endpoint);
      if (!r.ok) return send(res, 502, { error: 'Giphy did not answer. Check the API key.' });
      const j = await r.json();
      return send(res, 200, { results: j.data.map(g => ({
        title: g.title,
        preview: g.images.fixed_height_small?.url || g.images.fixed_height.url,
        url: g.images.original.url.split('?')[0],
      })) });
    }

    if (req.method === 'POST' && p === '/api/gifs') {
      const body = await readBody(req);
      const tier = body.tier ? String(body.tier).toUpperCase() : null;
      if (tier && !TIERS.includes(tier)) return send(res, 400, { error: 'Pick a tier from S to F.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.day || '')) return send(res, 400, { error: 'Missing day.' });
      // Favs are for today only (±1 day so every time zone works).
      if (Math.abs(Date.parse(body.day) - Date.parse(new Date().toISOString().slice(0, 10))) > 864e5)
        return send(res, 400, { error: 'You can only pick a fav for today.' });
      const by = String(body.by || '').trim().slice(0, 30);
      if (!by) return send(res, 400, { error: 'Add your name first.' });
      if (!isAdmin(req) && overLimit(req)) return send(res, 429, { error: "That's " + DAILY_ADD_LIMIT + " GIFs today. Come back tomorrow!" });

      let src;
      if (body.dataUrl) {
        const m = /^data:image\/(gif|png|jpeg|webp);base64,(.+)$/.exec(body.dataUrl);
        if (!m) return send(res, 400, { error: 'Only GIF, PNG, JPG or WebP files work.' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_UPLOAD) return send(res, 400, { error: 'That file is over 5 MB.' });
        const name = crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
        fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
        src = '/uploads/' + name;
      } else {
        src = await resolveGiphy(String(body.url || ''));
        if (!src) return send(res, 400, { error: "That doesn't look like a Giphy link. Try the link from Giphy's Share button." });
      }

      const owner = ownerHash(req);
      const caption = String(body.caption || '').slice(0, 80);
      const db = load();
      // One fav per person per day: picking again swaps your earlier one.
      const existing = owner && db.gifs.find(g => g.owner === owner && g.day === body.day);
      if (existing) {
        if (existing.src !== src && existing.src.startsWith('/uploads/'))
          fs.rm(path.join(UPLOAD_DIR, path.basename(existing.src)), () => {});
        Object.assign(existing, { src, caption, by, tier: tier || existing.tier, addedAt: new Date().toISOString() });
        save(db);
        return send(res, 200, { gif: publicGif(existing, req), replaced: true });
      }
      const gif = { id: crypto.randomUUID(), src, tier, day: body.day, caption, by, addedAt: new Date().toISOString(), owner };
      db.gifs.push(gif); save(db);
      return send(res, 201, { gif: publicGif(gif, req) });
    }

    const m = /^\/api\/gifs\/([\w-]+)$/.exec(p);
    if (m && req.method === 'PATCH') {
      const body = await readBody(req);
      const tier = String(body.tier || '').toUpperCase();
      if (!TIERS.includes(tier)) return send(res, 400, { error: 'Pick a tier from S to F.' });
      const db = load(); const g = db.gifs.find(x => x.id === m[1]);
      if (!g) return send(res, 404, { error: 'That GIF is gone.' });
      g.tier = tier; save(db);
      return send(res, 200, { gif: publicGif(g, req) });
    }
    if (m && req.method === 'DELETE') {
      const db = load(); const g = db.gifs.find(x => x.id === m[1]);
      if (!g) return send(res, 404, { error: 'That GIF is gone.' });
      if (!isAdmin(req) && !(g.owner && g.owner === ownerHash(req)))
        return send(res, 403, { error: 'Only the person who added this GIF can remove it.' });
      db.gifs = db.gifs.filter(x => x.id !== m[1]); save(db);
      if (g.src.startsWith('/uploads/')) fs.rm(path.join(UPLOAD_DIR, path.basename(g.src)), () => {});
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.message === 'too_big' ? 413 : 500, { error: e.message === 'too_big' ? 'That file is over 5 MB.' : 'Something broke on the server.' });
  }
});

server.listen(PORT, () => {
  console.log(`Fav of the Day running at http://localhost:${PORT}`);
  console.log(giphyKey() ? 'Giphy search: on' : 'Giphy search: off (set GIPHY_API_KEY to enable)');
  console.log(ADMIN_PASSCODE ? 'Admin passcode: set' : 'Admin passcode: not set (set ADMIN_PASSCODE)');
  console.log('Data stored in ' + DATA_DIR);
});
