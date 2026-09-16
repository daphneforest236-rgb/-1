import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from './vendor/api-client.mjs';
import { exportPlaylist } from './vendor/exporter.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(ROOT, '.state');
const STATE_FILE = path.join(STATE_DIR, 'connector.json');
const COOKIE_FILE = path.join(STATE_DIR, 'cookie.txt');
const PORT = Number(process.env.KTV_CONNECTOR_PORT || 16368);
const API_BASE = process.env.NETEASE_API_BASE || 'http://127.0.0.1:3000';
const STATE_WRITE_ATTEMPTS = 3;
const STATE_WRITE_RETRY_MS = 120;
let loginSession = null;
let syncing = false;

const blankState = () => ({
  version: 1,
  autoSync: true,
  syncPeriodHours: 12,
  sources: [],
  records: [],
  decisions: {},
  queue: [],
  batches: [],
  lastScan: null,
  lastSyncAt: null,
  lastError: null
});

async function readState() {
  try { return { ...blankState(), ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }; }
  catch { return blankState(); }
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isTransientStateWriteError = error => ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
async function writeState(state) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const temporaryFile = path.join(STATE_DIR, `connector.${process.pid}.${Date.now()}.tmp`);
  const contents = JSON.stringify(state, null, 2);
  let lastError;
  for (let attempt = 1; attempt <= STATE_WRITE_ATTEMPTS; attempt++) {
    try {
      await fs.writeFile(temporaryFile, contents, { encoding: 'utf8', mode: 0o600 });
      // Rename within the same directory replaces the complete JSON in one
      // operation, so a partial write never becomes connector.json.
      await fs.rename(temporaryFile, STATE_FILE);
      return;
    } catch (error) {
      lastError = error;
      await fs.unlink(temporaryFile).catch(() => {});
      if (!isTransientStateWriteError(error) || attempt === STATE_WRITE_ATTEMPTS) break;
      await sleep(STATE_WRITE_RETRY_MS * attempt);
    }
  }
  console.error('[connector state] save failed', {
    file: STATE_FILE,
    code: lastError?.code,
    message: lastError?.message,
    attempts: STATE_WRITE_ATTEMPTS
  });
  throw new Error(`扫描取得的数据未提交：本地状态保存失败（${lastError?.code || 'unknown'}：${lastError?.message || '未知错误'}）。`);
}
async function loadCookie() {
  try { return (await fs.readFile(COOKIE_FILE, 'utf8')).trim(); }
  catch { return ''; }
}
async function storeCookie(cookie) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(COOKIE_FILE, `${cookie.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
}
function client(cookie = '') { return new ApiClient({ baseURL: API_BASE, cookie }); }
function reply(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'null',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}
function rejectForeignOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    reply(res, 403, { error: 'Only local pages may use this connector.' }); return true;
  }
  return false;
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function extractMusicU(rawCookie) {
  const match = String(rawCookie || '').replaceAll(' HTTPOnly', '').match(/MUSIC_U=([^;]+)/);
  if (!match) throw new Error('网易云未返回有效的登录凭证。');
  return `MUSIC_U=${match[1]};`;
}
function languageFor(text) {
  if (/[ぁ-んァ-ヶ]/.test(text)) return { value: '日文', confidence: 'medium', reason: '标题含日文假名' };
  if (/[\u4e00-\u9fff]/.test(text)) return { value: '中文', confidence: 'medium', reason: '标题含汉字' };
  if (/[A-Za-z]/.test(text)) return { value: '英文', confidence: 'medium', reason: '标题含拉丁字母' };
  return { value: null, confidence: 'low', reason: '标题文字脚本无法判断' };
}
function vocalFor(text) {
  if (/(纯音乐|伴奏|instrumental|inst\.?|配乐|music\s*box)/i.test(text)) return { value: null, confidence: 'low', reason: '疑似纯音乐或伴奏，需要确认' };
  if (/(ost|tv\s*size)/i.test(text)) return { value: null, confidence: 'low', reason: '疑似 OST 或 TV size 版本，需要确认' };
  return { value: 'vocal', confidence: 'default', reason: '普通歌单歌曲默认作为可唱歌曲' };
}
function normalize(row, sourceId) {
  const language = languageFor(`${row.song_name} ${row.aliases || ''}`);
  const vocal = vocalFor(`${row.song_name} ${row.aliases || ''} ${row.album_name || ''}`);
  return {
    id: `netease-${row.netease_song_id}`,
    neteaseSongId: String(row.netease_song_id),
    title: row.song_name,
    artist: row.artist_names,
    album: row.album_name,
    durationMs: Number(row.duration_ms) || null,
    sourceIds: [sourceId],
    language,
    vocal,
    status: language.confidence === 'low' || vocal.confidence === 'low' ? 'pending' : 'ready'
  };
}
function applyDecision(record, decision) {
  if (!decision) return record;
  if (decision.ignored) {
    record.status = 'ignored';
    record.ignoreReason = '用户识别记忆：忽略';
    return record;
  }
  if (decision.language) record.language = { value: decision.language, confidence: 'memory', reason: '套用用户识别记忆' };
  if (decision.vocal) record.vocal = { value: decision.vocal, confidence: 'memory', reason: '套用用户识别记忆' };
  if (record.language?.value && record.vocal?.value) record.status = 'ready';
  return record;
}
function comparable(record) {
  return JSON.stringify({
    title: record.title || '',
    artist: record.artist || '',
    album: record.album || '',
    durationMs: record.durationMs || null,
    sourceIds: [...(record.sourceIds || [])].sort(),
    language: record.language || null,
    vocal: record.vocal || null,
    status: record.status || null
  });
}
function mergeRecord(target, incoming) {
  const before = comparable(target);
  target.title = incoming.title || target.title;
  target.artist = incoming.artist || target.artist;
  target.album = incoming.album || target.album;
  target.durationMs = incoming.durationMs || target.durationMs;
  target.sourceIds = [...new Set([...(target.sourceIds || []), ...(incoming.sourceIds || [])])];
  if (!target.language?.confidence || target.language.confidence !== 'manual') target.language = incoming.language || target.language;
  if (!target.vocal?.confidence || target.vocal.confidence !== 'manual') target.vocal = incoming.vocal || target.vocal;
  if (target.status !== 'ignored') target.status = incoming.status || target.status;
  return comparable(target) !== before;
}
function confirmQueueItem(state, itemId, input) {
  const item = state.queue.find(entry => entry.id === itemId);
  if (!item) throw new Error('待确认歌曲不存在或已处理。');
  const action = String(input.action || '').trim();
  state.decisions ||= {};
  const decision = state.decisions[item.neteaseSongId] ||= { confirmedAt: new Date().toISOString() };
  if (['中文', '日文', '英文', '韩文', '粤语', '法语', '西班牙语', '德语', '俄语', '泰语'].includes(action)) {
    item.language = { value: action, confidence: 'manual', reason: '用户确认语言' };
    if (!item.vocal?.value) item.vocal = { value: 'vocal', confidence: 'manual', reason: '用户确认可唱' };
    decision.language = action; decision.vocal = item.vocal.value; decision.ignored = false; decision.confirmedAt = new Date().toISOString();
    item.status = 'ready';
    return item;
  }
  if (action === '纯音乐' || action === '伴奏') {
    item.vocal = { value: action === '纯音乐' ? 'instrumental' : 'backing_track', confidence: 'manual', reason: `用户确认${action}` };
    decision.vocal = item.vocal.value; decision.ignored = true; decision.confirmedAt = new Date().toISOString();
    item.status = 'skipped';
    return item;
  }
  if (action === '忽略') {
    item.status = 'ignored';
    item.ignoreReason = input.reason || '用户忽略';
    decision.ignored = true; decision.confirmedAt = new Date().toISOString();
    return item;
  }
  throw new Error('不支持的待确认处理方式。');
}
function publicStatus(state, connected) {
  return {
    connector: 'ready', connected, apiBase: API_BASE, autoSync: state.autoSync,
    syncPeriodHours: state.syncPeriodHours, lastSyncAt: state.lastSyncAt,
    syncing, sources: state.sources.map(({ id, name, playlistId }) => ({ id, name, playlistId })),
    queueCount: state.queue.length, pendingCount: state.queue.filter(item => item.status === 'pending').length,
    recordCount: state.records.length, lastScan: state.lastScan, lastError: state.lastError
  };
}
async function syncSources(state, options = {}) {
  if (syncing) throw new Error('已有同步正在进行。');
  const cookie = await loadCookie();
  if (!cookie) throw new Error('登录已失效或尚未授权。请重新扫码。');
  if (!state.sources.length) throw new Error('请先选择至少一个同步歌单。');
  syncing = true;
  try {
    const api = client(cookie);
    const staged = new Map();
    const localSongIds = new Set((options.localSongIds || []).map(String));
    const recordIndex = new Map(state.records.map(record => [record.id, record]));
    const stats = { scanned: 0, added: 0, updated: 0, existing: 0, pending: 0, ignored: 0 };
    const updates = [];
    for (const source of state.sources) {
      const result = await exportPlaylist(api, source.playlistId);
      source.name = result.playlist.name;
      for (const row of result.rows) {
        const record = applyDecision(normalize(row, source.id), state.decisions?.[String(row.netease_song_id)]);
        const existing = staged.get(record.id);
        if (existing) existing.sourceIds.push(source.id);
        else staged.set(record.id, record);
      }
    }
    const queue = [];
    for (const record of staged.values()) {
      stats.scanned++;
      const known = recordIndex.get(record.id);
      if (record.status === 'ignored' || record.status === 'skipped') { stats.ignored++; continue; }
      if (known) {
        const changed = mergeRecord(known, record);
        if (changed) { updates.push(known); stats.updated++; }
        stats.existing++;
        // A historical pending record still needs to be shown to the current
        // scan. Otherwise it disappears merely because it was seen before.
        if (record.status === 'pending') { stats.pending++; queue.push(record); }
        continue;
      }
      if (localSongIds.has(record.id)) {
        state.records.push(record);
        recordIndex.set(record.id, record);
        updates.push(record);
        stats.existing++;
        stats.updated++;
        continue;
      }
      if (record.status === 'pending') { stats.pending++; queue.push(record); continue; }
      stats.added++;
      queue.push(record);
    }
    state.queue = queue;
    state.lastScan = { ...stats, at: new Date().toISOString() };
    state.lastError = null;
    // Return every ready record from this request, not only the records that
    // happen to be new to connector.json.  connector.json is a historical
    // cache; using it as the import payload would make an old scan mask a
    // fresh playlist scan in the web page.
    const songs = [...staged.values()].filter(record => record.status === 'ready');
    return { status: 'staged', queued: state.queue.length, ...stats, updates, songs };
  } catch (error) {
    state.lastError = error.message;
    throw error;
  } finally { syncing = false; }
}
async function handle(req, res) {
  if (rejectForeignOrigin(req, res)) return;
  if (req.method === 'OPTIONS') return reply(res, 204, {});
  const url = new URL(req.url, 'http://127.0.0.1');
  const state = await readState();
  const cookie = await loadCookie();
  try {
    if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, publicStatus(state, Boolean(cookie)));
    if (req.method === 'GET' && url.pathname === '/status') return reply(res, 200, publicStatus(state, Boolean(cookie)));
    if (req.method === 'POST' && url.pathname === '/settings') {
      const input = await body(req);
      if (typeof input.autoSync === 'boolean') state.autoSync = input.autoSync;
      if (input.syncPeriodHours !== undefined) {
        const hours = Number(input.syncPeriodHours);
        if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error('自动同步周期必须在 1 到 168 小时之间。');
        state.syncPeriodHours = hours;
      }
      await writeState(state); return reply(res, 200, publicStatus(state, Boolean(cookie)));
    }
    if (req.method === 'POST' && url.pathname === '/auth/qr') {
      const api = client(); const keyResponse = await api.get('/login/qr/key'); const key = keyResponse?.data?.unikey;
      if (!key) throw new Error('无法创建网易云二维码登录会话。');
      const qrResponse = await api.get('/login/qr/create', { key, qrimg: true });
      if (!qrResponse?.data?.qrimg) throw new Error('网易云未返回二维码。');
      loginSession = { key, createdAt: Date.now() };
      return reply(res, 200, { status: 'waiting_scan', qrimg: qrResponse.data.qrimg, expiresInSeconds: 300 });
    }
    if (req.method === 'GET' && url.pathname === '/auth/status') {
      if (!loginSession) return reply(res, 200, { status: cookie ? 'authorized' : 'idle' });
      const check = await client().get('/login/qr/check', { key: loginSession.key });
      if (check.code === 803) { await storeCookie(extractMusicU(check.cookie)); loginSession = null; return reply(res, 200, { status: 'authorized' }); }
      if (check.code === 802) return reply(res, 200, { status: 'scanned_waiting_confirmation' });
      if (check.code === 801) return reply(res, 200, { status: 'waiting_scan' });
      if (check.code === 800) { loginSession = null; return reply(res, 200, { status: 'expired' }); }
      throw new Error('网易云返回了未知二维码状态。');
    }
    if (req.method === 'GET' && url.pathname === '/sources') return reply(res, 200, { sources: state.sources });
    if (req.method === 'POST' && url.pathname === '/sources') {
      const input = await body(req); const playlistId = String(input.playlistId || '').trim();
      if (!/^\d+$/.test(playlistId)) throw new Error('歌单 ID 必须为数字。');
      if (!state.sources.some(source => source.playlistId === playlistId)) state.sources.push({ id: `playlist-${playlistId}`, playlistId, name: input.name || `歌单 ${playlistId}` });
      await writeState(state); return reply(res, 201, { sources: state.sources });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/sources/')) {
      const id = decodeURIComponent(url.pathname.slice('/sources/'.length)); state.sources = state.sources.filter(source => source.id !== id);
      await writeState(state); return reply(res, 200, { sources: state.sources });
    }
    if (req.method === 'POST' && url.pathname === '/sync') {
      const summary = await syncSources(state, await body(req)); await writeState(state); return reply(res, 200, summary);
    }
    if (req.method === 'GET' && url.pathname === '/queue') return reply(res, 200, { items: state.queue });
    if (req.method === 'POST' && url.pathname.startsWith('/queue/items/')) {
      const id = decodeURIComponent(url.pathname.slice('/queue/items/'.length));
      const item = confirmQueueItem(state, id, await body(req));
      await writeState(state); return reply(res, 200, { item });
    }
    if (req.method === 'POST' && url.pathname === '/queue/cancel') { state.queue = []; await writeState(state); return reply(res, 200, { cancelled: true }); }
    if (req.method === 'POST' && url.pathname === '/queue/commit') {
      const ready = state.queue.filter(item => item.status === 'ready');
      const additions = ready.filter(item => !state.records.some(record => record.id === item.id));
      const existing = ready.length - additions.length;
      state.records.push(...additions);
      if (ready.length) state.batches.unshift({ id: `batch-${Date.now()}`, createdAt: new Date().toISOString(), added: additions.length, queued: state.queue.length });
      state.lastSyncAt = new Date().toISOString(); state.queue = state.queue.filter(item => item.status === 'pending'); await writeState(state);
      return reply(res, 200, { committed: additions.length, existing, pending: state.queue.length, lastScan: state.lastScan });
    }
    return reply(res, 404, { error: 'Unknown connector endpoint.' });
  } catch (error) { return reply(res, 400, { error: error.message }); }
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`KTV connector listening on http://127.0.0.1:${PORT}`));
