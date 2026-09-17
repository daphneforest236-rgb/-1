import crypto from 'node:crypto';
import { getPlaylistDetail, NeteaseMetadataError } from './netease-metadata.mjs';
import { transaction } from './db.mjs';

const playlistIdPattern = /^[1-9]\d{0,19}$/;

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
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['music.163.com', 'www.music.163.com'].includes(url.hostname)) return null;
  const hashRoute = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  const [hashPath, hashQuery = ''] = hashRoute.split('?');
  const isPlaylistPath = url.pathname === '/playlist' || hashPath === '/playlist';
  if (!isPlaylistPath) return null;
  return url.searchParams.get('id') || new URLSearchParams(hashQuery).get('id');
}

export function parsePublicPlaylistId(value) {
  const input = String(value || '').trim();
  if (!input) {
    throw new PlaylistImportError('PLAYLIST_REQUIRED', '请填写网易云公开歌单 ID 或链接。');
  }
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
    sourceSongId: String(song.sourceId),
    title: song.name,
    artist,
    // Language categorisation is intentionally not inferred in Phase 3D.
    lang: '中文',
    cover: 'a',
    recent: 0,
    total: 0,
    pref: '正常',
    black: false,
    manual: false,
    source: 'netease'
  };
}

function playlistTracks(playlist) {
  return playlist.tracks.map(importedTrack);
}

async function existingSourceIds(client, userId, sourceIds) {
  if (!sourceIds.length) return new Set();
  const result = await client.query(
    'SELECT source_song_id FROM user_library_tracks WHERE user_id = $1 AND source_song_id = ANY($2::text[])',
    [userId, sourceIds]
  );
  return new Set(result.rows.map(row => String(row.source_song_id)));
}

async function loadPlaylist(input) {
  const playlistId = parsePublicPlaylistId(input);
  let playlist;
  try {
    playlist = await getPlaylistDetail(playlistId);
  } catch (error) {
    if (error instanceof NeteaseMetadataError) {
      throw new PlaylistImportError(error.code, error.message, { status: error.status, cause: error });
    }
    throw error;
  }
  return playlist;
}

export async function previewPublicPlaylist(client, userId, input) {
  const playlist = await loadPlaylist(input);
  const tracks = playlistTracks(playlist);
  const existing = await existingSourceIds(client, userId, tracks.map(track => track.sourceSongId));
  const duplicateCount = tracks.filter(track => existing.has(track.sourceSongId)).length;
  return {
    playlist: { source: playlist.source, sourceId: playlist.sourceId, name: playlist.name },
    total: playlist.trackCount,
    newCount: tracks.length - duplicateCount,
    duplicateCount,
    complete: playlist.complete,
    tracks: playlist.tracks
  };
}

export async function importPublicPlaylist(userId, input) {
  const playlist = await loadPlaylist(input);
  if (!playlist.complete) {
    throw new PlaylistImportError('PLAYLIST_INCOMPLETE', '网易云未返回完整歌单，无法安全导入。', { status: 409 });
  }
  const tracks = playlistTracks(playlist);
  return transaction(async client => {
    let imported = 0;
    for (const track of tracks) {
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
    return {
      playlist: { source: playlist.source, sourceId: playlist.sourceId, name: playlist.name },
      total: playlist.trackCount,
      imported,
      skipped: tracks.length - imported,
      failed: 0,
      complete: true
    };
  });
}
