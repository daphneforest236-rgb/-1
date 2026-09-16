import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.mjs';
import { hashPassword, hashToken, newOpaqueToken, verifyPassword } from './passwords.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const cookieName = 'ktv_session';
const allowedOrigins = new Set((process.env.APP_ORIGIN || 'http://localhost:5173').split(',').map(value => value.trim()).filter(Boolean));
const allowFileOrigin = process.env.ALLOW_FILE_ORIGIN === 'true';
const secureCookie = process.env.WEB_COOKIE_SECURE !== 'false';
const distDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const staticFiles = new Map([
  ['/', { name: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { name: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/playlist.js', { name: 'playlist.js', type: 'text/javascript; charset=utf-8' }],
  ['/cloud-library.js', { name: 'cloud-library.js', type: 'text/javascript; charset=utf-8' }]
]);

async function serveStaticPage(req, res) {
  if (req.method !== 'GET') return false;
  const pathname = new URL(req.url, 'http://local').pathname;
  const asset = staticFiles.get(pathname);
  if (!asset) return false;
  try {
    const file = await readFile(path.join(distDirectory, asset.name));
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
    res.end(file);
    return true;
  } catch (error) {
    console.error('[web-api] static page failed', { code: error?.code, message: error?.message });
    reply(res, 500, { error: '测试页面读取失败。' });
    return true;
  }
}

function reply(res, status, payload, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin && (allowedOrigins.has(origin) || (allowFileOrigin && origin === 'null'))) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function setSessionCookie(res, token) {
  const attributes = [`${cookieName}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=604800'];
  if (secureCookie) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res) {
  const attributes = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookie) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

async function body(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求内容过大。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求不是有效 JSON。'); }
}

function validEmail(email) { return /^\S+@\S+\.\S+$/.test(String(email)); }
function validPassword(password) { return typeof password === 'string' && password.length >= 10 && password.length <= 200; }
const trackColumns = 'id, source_song_id, title, artist, lang, cover, recent, total, pref, black, manual, source, created_at, updated_at';
const trackInsertColumns = 'id, source_song_id, title, artist, lang, cover, recent, total, pref, black, manual, source, user_id';
const allowedPref = new Set(['少推荐', '正常', '多推荐']);
const allowedCover = new Set(['a', 'b', 'c', 'd', 'e', 'f']);

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizeTrack(input, { requireTitle = true } = {}) {
  const title = String(input?.title || '').trim();
  const artist = String(input?.artist || '').trim();
  if (requireTitle && (!title || !artist)) throw new Error('歌曲必须填写歌名和歌手。');
  if (title.length > 200 || artist.length > 200) throw new Error('歌名和歌手不能超过 200 个字符。');
  const lang = String(input?.lang || '中文').trim().slice(0, 40) || '中文';
  const sourceSongId = String(input?.sourceSongId || input?.id || `manual-${crypto.randomUUID()}`).trim();
  if (!sourceSongId || sourceSongId.length > 220) throw new Error('歌曲来源标识无效。');
  const cover = allowedCover.has(input?.cover) ? input.cover : 'a';
  return {
    sourceSongId,
    title,
    artist,
    lang,
    cover,
    recent: nonNegativeInt(input?.recent),
    total: nonNegativeInt(input?.total),
    pref: allowedPref.has(input?.pref) ? input.pref : '正常',
    black: Boolean(input?.black),
    manual: Boolean(input?.manual),
    source: String(input?.source || 'manual').trim().slice(0, 60) || 'manual'
  };
}

function trackPayload(row) {
  return {
    id: row.id,
    sourceSongId: row.source_song_id,
    title: row.title,
    artist: row.artist,
    lang: row.lang,
    cover: row.cover,
    recent: row.recent,
    total: row.total,
    pref: row.pref,
    black: row.black,
    manual: row.manual,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function currentUser(req) {
  const token = cookies(req)[cookieName];
  if (!token) return null;
  const result = await query(
    `SELECT u.id, u.email, u.display_name
       FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return result.rows[0] || null;
}

async function createSession(userId, res) {
  const token = newOpaqueToken();
  await query(
    'INSERT INTO app_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval \'7 days\')',
    [crypto.randomUUID(), userId, hashToken(token)]
  );
  setSessionCookie(res, token);
}

async function handle(req, res) {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    if (!origin || !(allowedOrigins.has(origin) || (allowFileOrigin && origin === 'null'))) return reply(res, 403, { error: '不允许的网页来源。' }, origin);
    res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' });
    return res.end();
  }
  try {
    if (await serveStaticPage(req, res)) return;
    if (req.method === 'GET' && req.url === '/health') {
      await query('SELECT 1');
      return reply(res, 200, { status: 'ok', service: 'ktv-web-api', database: 'connected' }, origin);
    }

    if (req.method === 'POST' && req.url === '/auth/register') {
      const input = await body(req);
      const email = String(input.email || '').trim().toLowerCase();
      const displayName = String(input.displayName || '').trim();
      if (!validEmail(email) || !validPassword(input.password) || !displayName || displayName.length > 80) throw new Error('请填写有效邮箱、显示名称，以及至少 10 位密码。');
      const userId = crypto.randomUUID();
      try {
        await query('INSERT INTO app_users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)', [userId, email, displayName, await hashPassword(input.password)]);
      } catch (error) {
        if (error?.code === '23505') throw new Error('该邮箱已注册。');
        throw error;
      }
      await createSession(userId, res);
      return reply(res, 201, { user: { id: userId, email, displayName } }, origin);
    }

    if (req.method === 'POST' && req.url === '/auth/login') {
      const input = await body(req);
      const email = String(input.email || '').trim().toLowerCase();
      const result = await query('SELECT id, email, display_name, password_hash FROM app_users WHERE email = $1', [email]);
      const user = result.rows[0];
      if (!user || !(await verifyPassword(String(input.password || ''), user.password_hash))) return reply(res, 401, { error: '邮箱或密码不正确。' }, origin);
      await createSession(user.id, res);
      return reply(res, 200, { user: { id: user.id, email: user.email, displayName: user.display_name } }, origin);
    }

    if (req.method === 'POST' && req.url === '/auth/logout') {
      const token = cookies(req)[cookieName];
      if (token) await query('DELETE FROM app_sessions WHERE token_hash = $1', [hashToken(token)]);
      clearSessionCookie(res);
      return reply(res, 200, { ok: true }, origin);
    }

    const user = await currentUser(req);
    if (!user) return reply(res, 401, { error: '请先登录网站账号。' }, origin);
    if (req.method === 'GET' && req.url === '/me') return reply(res, 200, { user: { id: user.id, email: user.email, displayName: user.display_name } }, origin);

    if (req.method === 'GET' && req.url === '/phase1/items') {
      const result = await query('SELECT id, value, created_at FROM user_test_items WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
      return reply(res, 200, { items: result.rows }, origin);
    }

    if (req.method === 'POST' && req.url === '/phase1/items') {
      const input = await body(req);
      const value = String(input.value || '').trim();
      if (!value || value.length > 200) throw new Error('测试数据必须为 1 到 200 个字符。');
      const result = await query('INSERT INTO user_test_items (id, user_id, value) VALUES ($1, $2, $3) RETURNING id, value, created_at', [crypto.randomUUID(), user.id, value]);
      return reply(res, 201, { item: result.rows[0] }, origin);
    }

    if (req.method === 'GET' && req.url === '/library/tracks') {
      const result = await query(`SELECT ${trackColumns} FROM user_library_tracks WHERE user_id = $1 ORDER BY created_at ASC`, [user.id]);
      return reply(res, 200, { tracks: result.rows.map(trackPayload) }, origin);
    }

    if (req.method === 'POST' && req.url === '/library/tracks') {
      const track = normalizeTrack(await body(req));
      const result = await query(
        `INSERT INTO user_library_tracks (${trackInsertColumns})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${trackColumns}`,
        [crypto.randomUUID(), track.sourceSongId, track.title, track.artist, track.lang, track.cover, track.recent, track.total, track.pref, track.black, track.manual, track.source, user.id]
      );
      return reply(res, 201, { track: trackPayload(result.rows[0]) }, origin);
    }

    if (req.method === 'POST' && req.url === '/library/import') {
      const input = await body(req, 128 * 1024);
      if (!Array.isArray(input.tracks) || input.tracks.length === 0) throw new Error('没有可导入的本机歌曲。');
      if (input.tracks.length > 500) throw new Error('一次最多导入 500 首歌曲。');
      let added = 0;
      for (const item of input.tracks) {
        const track = normalizeTrack(item);
        const result = await query(
          `INSERT INTO user_library_tracks (${trackInsertColumns})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (user_id, source_song_id) DO NOTHING
           RETURNING id`,
          [crypto.randomUUID(), track.sourceSongId, track.title, track.artist, track.lang, track.cover, track.recent, track.total, track.pref, track.black, track.manual, track.source, user.id]
        );
        added += result.rowCount;
      }
      return reply(res, 200, { added, skipped: input.tracks.length - added });
    }

    const trackMatch = req.url.match(/^\/library\/tracks\/([0-9a-f-]{36})$/i);
    if (trackMatch && req.method === 'PATCH') {
      const input = await body(req);
      const updates = [];
      const values = [];
      const permitted = {
        lang: value => String(value || '').trim().slice(0, 40) || '中文',
        pref: value => { if (!allowedPref.has(value)) throw new Error('推荐等级无效。'); return value; },
        black: value => Boolean(value),
        manual: value => Boolean(value),
        title: value => { const text = String(value || '').trim(); if (!text || text.length > 200) throw new Error('歌名无效。'); return text; },
        artist: value => { const text = String(value || '').trim(); if (!text || text.length > 200) throw new Error('歌手无效。'); return text; }
      };
      for (const [key, validate] of Object.entries(permitted)) {
        if (Object.hasOwn(input, key)) { values.push(validate(input[key])); updates.push(`${key} = $${values.length}`); }
      }
      if (!updates.length) throw new Error('没有可修改的歌曲属性。');
      values.push(trackMatch[1], user.id);
      const result = await query(`UPDATE user_library_tracks SET ${updates.join(', ')}, updated_at = now() WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING ${trackColumns}`, values);
      if (!result.rowCount) return reply(res, 404, { error: '歌曲不存在或不属于当前账号。' }, origin);
      return reply(res, 200, { track: trackPayload(result.rows[0]) }, origin);
    }

    if (trackMatch && req.method === 'DELETE') {
      const result = await query('DELETE FROM user_library_tracks WHERE id = $1 AND user_id = $2 RETURNING id', [trackMatch[1], user.id]);
      if (!result.rowCount) return reply(res, 404, { error: '歌曲不存在或不属于当前账号。' }, origin);
      return reply(res, 200, { ok: true, id: result.rows[0].id }, origin);
    }

    return reply(res, 404, { error: '接口不存在。' }, origin);
  } catch (error) {
    console.error('[web-api]', { code: error?.code, message: error?.message });
    return reply(res, 400, { error: error?.message || '服务器请求失败。' }, origin);
  }
}

http.createServer(handle).listen(port, host, () => console.log(`KTV web API listening on http://${host}:${port}`));
