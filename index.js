// QueenMusic Bridge — convierte un video de YouTube en una URL de audio directa
// usando yt-dlp. Suficiente y solo para reproducir:
//   GET /streams/<videoId>   ->  { ok: true, url: "<https mp4/webm audo>" }
//   GET /healthz             ->  { ok: true }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('youtube-dl-exec');
const youtubedl = mod.default || mod;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const FORMAT = 'bestaudio[protocol^=http]/bestaudio/best';
const PLAYER_CLIENTS = ['', 'youtube:player_client=android', 'youtube:player_client=ios'];

// Garantiza que el binario yt-dlp existe donde el paquete lo espera.
// Si el postinstall quedó bloqueado, descarga el binario oficial al arrancar.
function packageBinDir() {
  const pkgPath = require.resolve('youtube-dl-exec/package.json');
  return path.join(path.dirname(pkgPath), 'bin');
}

function binaryName() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

async function downloadBinary(binPath) {
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${exe}`;
  console.log(`Descargando yt-dlp desde ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga yt-dlp: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, buf);
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755);
  console.log('Binario yt-dlp descargado.');
}

async function ensureBinary() {
  const binPath = path.join(packageBinDir(), binaryName());
  if (fs.existsSync(binPath)) {
    try {
      await new Promise((resolve, reject) =>
        execFile(binPath, ['--version'], (err) => (err ? reject(err) : resolve()))
      );
      console.log(`yt-dlp OK: ${binPath}`);
      return;
    } catch (err) {
      console.warn('Binario presente pero no ejecutable, se descargará de nuevo.');
    }
  }
  await downloadBinary(binPath);
}

const CACHE_TTL = 3 * 60 * 60 * 1000; // las URLs firmadas de YouTube caducan ~6 h
const cache = new Map();

async function extractAudioUrl(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  let lastError = null;
  for (const client of PLAYER_CLIENTS) {
    const opts = {
      getUrl: true,
      noPlaylist: true,
      noWarnings: true,
      format: FORMAT,
    };
    if (client) opts.extractorArgs = client;
    try {
      const out = await youtubedl(url, opts);
      const clean = String(out).trim().split(/\r?\n/).filter(Boolean).pop();
      if (clean && /^https:\/\//.test(clean)) return clean;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No se pudo extraer una URL de audio');
}

function json(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === 'OPTIONS') return json(res, 204, {});

    if (url.pathname === '/' || url.pathname === '/healthz') {
      return json(res, 200, { ok: true, service: 'queenmusic-bridge' });
    }

    if (url.pathname === '/streams' || url.pathname.startsWith('/streams/')) {
      const videoId = decodeURIComponent(url.pathname.split('/')[2] || '').trim();
      if (!/^[\w-]{6,}/.test(videoId)) return json(res, 400, { ok: false, error: 'videoId inválido' });

      const cached = cache.get(videoId);
      if (cached && Date.now() - cached.at < CACHE_TTL) {
        return json(res, 200, { ok: true, url: cached.url, cached: true });
      }

      const extracted = await extractAudioUrl(videoId);
      cache.set(videoId, { url: extracted, at: Date.now() });
      return json(res, 200, { ok: true, url: extracted });
    }

    return json(res, 404, { ok: false, error: 'Ruta no encontrada' });
  } catch (err) {
    console.error('[bridge]', err && err.message ? err.message : err);
    return json(res, 500, { ok: false, error: (err && err.message) || 'Error interno' });
  }
});

server.listen(PORT, async () => {
  console.log(`queenmusic-bridge escuchando en :${PORT}`);
  try {
    await ensureBinary();
  } catch (err) {
    console.error('Fallo al preparar yt-dlp:', err.message);
  }
});