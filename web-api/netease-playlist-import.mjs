import crypto from 'node:crypto';
import { getPlaylistDetail, NeteaseMetadataError } from './netease-metadata.mjs';
import { transaction } from './db.mjs';

const playlistIdPattern = /^[1-9]\d{0,19}$/;
export const MAX_BATCH_PLAYLISTS = 10;
const PLAYLIST_FETCH_CONCURRENCY = 2;

export class PlaylistImportError extends Error {
  constructor(code, message, { status = 400, cause } = {}) {
    super(message);
    this.name = 'PlaylistImportError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function playlistIdFromUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['music.163.com', 'www.music.163.com'].includes(url.hostname)) return null;
  const hashRoute = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  const [hashPath, hashQuery = ''] = hashRoute.split('?');
  if (url.pathname !== '/playlist' && hashPath !== '/playlist') return null;
  return url.searchParams.get('id') || new URLSearchParams(hashQuery).get('id');
}

export function parsePublicPlaylistId(value) {
  const input = String(value || '').trim();
  if (!input) throw new PlaylistImportError('PLAYLIST_REQUIRED', '请填写网易云公开歌单 ID 或链接。');
  const candidate = playlistIdPattern.test(input) ? input : playlistIdFromUrl(input);
  if (!candidate || !playlistIdPattern.test(candidate)) {
    throw new PlaylistImportError('PLAYLIST_INPUT_INVALID', '请输入有效的网易云公开歌单 ID 或 music.163.com 歌单链接。');
  }
  return candidate;
}

function importedTrack(song) {
  const artist = song.artists.map(item => item.name).filter(Boolean).join(' / ').trim();
  if (!song.sourceId || !song.name || !artist) {
    throw new PlaylistImportError('PLAYLIST_TRACK_INVALID', '歌单中包含无法写入曲库的歌曲资料。', { status: 502 });
  }
  return {
    sourceSongId: String(song.sourceId), title: song.name, artist,
    // Language categorisation is intentionally not inferred in Phase 3E.
    lang: '中文', cover: 'a', recent: 0, total: 0, pref: '正常',
    black: false, manual: false, source: 'netease'
  };
}

async function existingSourceIds(client, userId, sourceIds) {
  if (!sourceIds.length) return new Set();
  const result = await client.query(
    'SELECT source_song_id FROM user_library_tracks WHERE user_id = $1 AND source_song_id = ANY($2::text[])',
    [userId, sourceIds]
  );
  return new Set(result.rows.map(row => String(row.source_song_id)));
}

async function loadPlaylist(playlistId) {
  try { return await getPlaylistDetail(playlistId); }
  catch (error) {
    if (error instanceof NeteaseMetadataError) {
      throw new PlaylistImportError(error.code, error.message, { status: error.status, cause: error });
    }
    throw error;
  }
}

async function mapLimited(items, mapper, limit = PLAYLIST_FETCH_CONCURRENCY) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function normalizePlaylistInputs(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) {
    throw new PlaylistImportError('PLAYLISTS_REQUIRED', '请至少添加一个网易云公开歌单。');
  }
  if (inputs.length > MAX_BATCH_PLAYLISTS) {
    throw new PlaylistImportError('PLAYLISTS_LIMIT_EXCEEDED', `一次最多导入 ${MAX_BATCH_PLAYLISTS} 个歌单。`);
  }
  const uniqueIds = new Set();
  const invalid = [];
  const playlistIds = [];
  let duplicatePlaylistInputCount = 0;
  for (const input of inputs) {
    try {
      const playlistId = parsePublicPlaylistId(input);
      if (uniqueIds.has(playlistId)) { duplicatePlaylistInputCount += 1; continue; }
      uniqueIds.add(playlistId);
      playlistIds.push(playlistId);
    } catch (error) {
      invalid.push({
        source: 'netease', sourceId: null, name: null, trackCount: 0, returnedTrackCount: 0,
        complete: false,
        error: { code: error.code || 'PLAYLIST_INPUT_INVALID', message: error.message }
      });
    }
  }
  return { playlistIds, invalid, duplicatePlaylistInputCount };
}

function playlistErrorItem(playlistId, error) {
  return {
    source: 'netease', sourceId: playlistId, name: null, trackCount: 0, returnedTrackCount: 0,
    complete: false,
    error: {
      code: error instanceof PlaylistImportError ? error.code : 'PLAYLIST_UPSTREAM_FAILED',
      message: error instanceof PlaylistImportError ? error.message : '网易云歌单读取失败。'
    }
  };
}

async function loadBatchPlaylists(inputs) {
  const normalized = normalizePlaylistInputs(inputs);
  const loaded = await mapLimited(normalized.playlistIds, async playlistId => {
    try {
      const playlist = await loadPlaylist(playlistId);
      return {
        item: {
          source: playlist.source, sourceId: playlist.sourceId, name: playlist.name,
          trackCount: playlist.trackCount, returnedTrackCount: playlist.tracks.length,
          complete: playlist.complete, error: null
        },
        metadataTracks: playlist.tracks,
        tracks: playlist.tracks.map(importedTrack)
      };
    } catch (error) {
      return { item: playlistErrorItem(playlistId, error), tracks: [] };
    }
  });
  return { ...normalized, loaded };
}

function uniqueTracks(loaded) {
  const unique = new Map();
  let rawTrackCount = 0;
  for (const result of loaded) {
    rawTrackCount += result.tracks.length;
    for (const track of result.tracks) unique.set(track.sourceSongId, track);
  }
  return { rawTrackCount, tracks: [...unique.values()], crossPlaylistDuplicateCount: rawTrackCount - unique.size };
}

function batchSummary(batch, existing = new Set()) {
  const playlists = [...batch.loaded.map(result => result.item), ...batch.invalid];
  const unique = uniqueTracks(batch.loaded);
  const existingCount = unique.tracks.filter(track => existing.has(track.sourceSongId)).length;
  const complete = playlists.length > 0 && playlists.every(playlist => playlist.complete && !playlist.error);
  return {
    playlistCount: batch.loaded.length,
    duplicatePlaylistInputCount: batch.duplicatePlaylistInputCount,
    rawTrackCount: unique.rawTrackCount,
    uniqueTrackCount: unique.tracks.length,
    crossPlaylistDuplicateCount: unique.crossPlaylistDuplicateCount,
    existingCount,
    newCount: unique.tracks.length - existingCount,
    complete,
    playlists,
    tracks: unique.tracks
  };
}

function requireCompleteBatch(summary) {
  if (!summary.complete) {
    throw new PlaylistImportError('BATCH_IMPORT_BLOCKED', '存在读取失败或不完整的歌单，不能导入。请删除问题歌单后重新预览。', { status: 409 });
  }
}

export async function previewPublicPlaylists(client, userId, inputs) {
  const batch = await loadBatchPlaylists(inputs);
  const unique = uniqueTracks(batch.loaded);
  const existing = await existingSourceIds(client, userId, unique.tracks.map(track => track.sourceSongId));
  return batchSummary(batch, existing);
}

export async function importPublicPlaylists(userId, inputs) {
  const batch = await loadBatchPlaylists(inputs);
  const summary = batchSummary(batch);
  requireCompleteBatch(summary);
  return transaction(async client => {
    const existing = await existingSourceIds(client, userId, summary.tracks.map(track => track.sourceSongId));
    let imported = 0;
    for (const track of summary.tracks) {
      if (existing.has(track.sourceSongId)) continue;
      const result = await client.query(
        `INSERT INTO user_library_tracks
          (id, source_song_id, title, artist, lang, cover, recent, total, pref, black, manual, source, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (user_id, source_song_id) DO NOTHING
         RETURNING id`,
        [crypto.randomUUID(), track.sourceSongId, track.title, track.artist, track.lang, track.cover, track.recent, track.total, track.pref, track.black, track.manual, track.source, userId]
      );
      imported += result.rowCount;
    }
    return { ...batchSummary(batch, existing), imported, skipped: summary.uniqueTrackCount - imported, failed: 0 };
  });
}

// Phase 3D compatibility: a single playlist is the batch core with one input.
export async function previewPublicPlaylist(client, userId, input) {
  const batch = await loadBatchPlaylists([input]);
  const unique = uniqueTracks(batch.loaded);
  const existing = await existingSourceIds(client, userId, unique.tracks.map(track => track.sourceSongId));
  const summary = batchSummary(batch, existing);
  const playlist = summary.playlists[0];
  if (!playlist || playlist.error) {
    throw new PlaylistImportError(playlist?.error?.code || 'PLAYLIST_UPSTREAM_FAILED', playlist?.error?.message || '网易云歌单读取失败。');
  }
  return {
    playlist: { source: playlist.source, sourceId: playlist.sourceId, name: playlist.name },
    total: summary.rawTrackCount, newCount: summary.newCount, duplicateCount: summary.existingCount,
    complete: summary.complete,
    tracks: batch.loaded[0].metadataTracks
  };
}

export async function importPublicPlaylist(userId, input) {
  const result = await importPublicPlaylists(userId, [input]);
  const playlist = result.playlists[0];
  return {
    playlist: { source: playlist.source, sourceId: playlist.sourceId, name: playlist.name },
    total: result.rawTrackCount, imported: result.imported, skipped: result.skipped,
    failed: result.failed, complete: result.complete
  };
}
