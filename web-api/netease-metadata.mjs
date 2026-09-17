import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const neteaseApi = require('@neteasecloudmusicapienhanced/api');

const DEFAULT_TIMEOUT_MS = 8_000;
const idPattern = /^[1-9]\d{0,19}$/;

export class NeteaseMetadataError extends Error {
  constructor(code, message, { status = 502, cause } = {}) {
    super(message);
    this.name = 'NeteaseMetadataError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function timeoutMs() {
  const configured = Number(process.env.NETEASE_METADATA_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 30_000
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function assertId(value, label) {
  const id = String(value || '').trim();
  if (!idPattern.test(id)) {
    throw new NeteaseMetadataError('NETEASE_ID_INVALID', `${label}格式无效。`, { status: 400 });
  }
  return id;
}

function normalizeArtists(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(artist => artist && artist.name)
    .map(artist => ({
      id: artist.id == null ? null : String(artist.id),
      name: String(artist.name)
    }));
}

function normalizeSong(raw) {
  const sourceId = raw?.id == null ? '' : String(raw.id);
  const name = String(raw?.name || '').trim();
  if (!sourceId || !name) {
    throw new NeteaseMetadataError('NETEASE_RESPONSE_INVALID', '网易云返回的歌曲数据不完整。');
  }
  const album = raw.al || raw.album || {};
  const duration = Number(raw.dt ?? raw.duration);
  return {
    source: 'netease',
    sourceId,
    name,
    artists: normalizeArtists(raw.ar || raw.artists),
    album: {
      id: album.id == null ? null : String(album.id),
      name: album.name ? String(album.name) : null,
      coverUrl: album.picUrl ? String(album.picUrl) : null
    },
    durationMs: Number.isSafeInteger(duration) && duration >= 0 ? duration : null
  };
}

function metadataOptions() {
  return {
    // These options are deliberately fixed. Do not add user-controlled cookie,
    // IP, proxy, unblock, playback, or login options to this adapter.
    cookie: {},
    crypto: 'weapi',
    randomCNIP: false,
    checkToken: false,
    timeout: timeoutMs()
  };
}

async function callMetadata(operation) {
  const limit = timeoutMs();
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new NeteaseMetadataError('NETEASE_TIMEOUT', '网易云元数据请求超时。', { status: 504 })), limit);
      })
    ]);
  } catch (error) {
    if (error instanceof NeteaseMetadataError) throw error;
    const code = error?.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      throw new NeteaseMetadataError('NETEASE_TIMEOUT', '网易云元数据请求超时。', { status: 504, cause: error });
    }
    throw new NeteaseMetadataError('NETEASE_UPSTREAM_UNAVAILABLE', '网易云元数据服务暂时不可用。', { status: 502, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export function validateSearchQuery(value) {
  const query = String(value || '').trim();
  if (!query) {
    throw new NeteaseMetadataError('NETEASE_SEARCH_QUERY_REQUIRED', '请填写要搜索的歌曲名称。', { status: 400 });
  }
  if (query.length > 80) {
    throw new NeteaseMetadataError('NETEASE_SEARCH_QUERY_TOO_LONG', '搜索内容不能超过 80 个字符。', { status: 400 });
  }
  return query;
}

export async function searchSongs(value) {
  const query = validateSearchQuery(value);
  const result = await callMetadata(() => neteaseApi.search({
    keywords: query,
    type: 1,
    limit: 20,
    ...metadataOptions()
  }));
  const songs = result?.body?.result?.songs;
  if (!Array.isArray(songs)) {
    throw new NeteaseMetadataError('NETEASE_RESPONSE_INVALID', '网易云未返回可用的搜索结果。');
  }
  return { query, songs: songs.map(normalizeSong) };
}

export async function getSongDetail(value) {
  const id = assertId(value, '网易云歌曲 ID');
  const result = await callMetadata(() => neteaseApi.song_detail({
    ids: id,
    ...metadataOptions()
  }));
  const song = result?.body?.songs?.[0];
  if (!song) {
    throw new NeteaseMetadataError('NETEASE_SONG_NOT_FOUND', '未找到该网易云歌曲。', { status: 404 });
  }
  return normalizeSong(song);
}

export async function getPlaylistDetail(value) {
  const id = assertId(value, '网易云歌单 ID');
  const result = await callMetadata(() => neteaseApi.playlist_detail({
    id,
    ...metadataOptions()
  }));
  const playlist = result?.body?.playlist;
  if (!playlist) {
    throw new NeteaseMetadataError('NETEASE_PLAYLIST_NOT_FOUND', '未找到该网易云公开歌单。', { status: 404 });
  }
  const tracks = Array.isArray(playlist.tracks) ? playlist.tracks.map(normalizeSong) : [];
  const trackCount = Number(playlist.trackCount);
  if (!Number.isSafeInteger(trackCount) || trackCount < 0) {
    throw new NeteaseMetadataError('NETEASE_RESPONSE_INVALID', '网易云歌单曲目数无效。');
  }
  const complete = tracks.length === trackCount;
  return {
    source: 'netease',
    sourceId: String(playlist.id ?? id),
    name: String(playlist.name || '').trim() || '未命名歌单',
    trackCount,
    tracks,
    complete,
    incompleteReason: complete ? null : `网易云声明 ${trackCount} 首，实际返回 ${tracks.length} 首。`
  };
}
