function parsePlaylistId(input) {
  const text = String(input).trim();
  if (/^\d+$/.test(text)) return text;
  const match = text.match(/[?&]id=(\d+)/) || text.match(/playlist\/(\d+)/) || text.match(/\/playlist\?id=(\d+)/);
  if (!match) throw new Error('歌单 ID 无效。请输入网易云歌单链接中的数字 ID。');
  return match[1];
}

function joinNames(items) { return (items || []).map(item => item?.name).filter(Boolean).join(' / '); }
function joinIds(items) { return (items || []).map(item => item?.id).filter(id => id !== undefined && id !== null).join(' / '); }

function buildRow({ id, index, song, playlistId, playlistName }) {
  if (!song) return { index, playlist_id: playlistId, playlist_name: playlistName, netease_song_id: id, song_name: '', artist_names: '', artist_ids: '', album_name: '', album_id: '', duration_ms: '', aliases: '', source_url: `https://music.163.com/song?id=${id}`, status: 'missing_detail' };
  const artists = song.ar || song.artists || [];
  const album = song.al || song.album || {};
  return { index, playlist_id: playlistId, playlist_name: playlistName, netease_song_id: song.id ?? id, song_name: song.name ?? '', artist_names: joinNames(artists), artist_ids: joinIds(artists), album_name: album.name ?? '', album_id: album.id ?? '', duration_ms: song.dt ?? song.duration ?? '', aliases: (song.alia || song.alias || []).join(' / '), source_url: `https://music.163.com/song?id=${song.id ?? id}`, status: 'ok' };
}

export async function exportPlaylist(api, input, options = {}) {
  const playlistId = parsePlaylistId(input);
  const detail = await api.get('/playlist/detail', { id: playlistId });
  if (!detail.playlist) throw new Error('网易云没有返回歌单。请检查歌单 ID、可见性和登录状态。');
  const playlistName = detail.playlist.name || `歌单 ${playlistId}`;
  const trackIds = (detail.playlist.trackIds || []).map(track => track?.id ?? track).filter(Boolean);
  if (!trackIds.length) throw new Error('网易云返回的歌单没有歌曲。');
  const songMap = new Map();
  const batchSize = options.batchSize || 400;
  for (let i = 0; i < trackIds.length; i += batchSize) {
    const data = await api.get('/song/detail', { ids: trackIds.slice(i, i + batchSize).join(',') });
    for (const song of data.songs || []) if (song?.id !== undefined && song?.id !== null) songMap.set(String(song.id), song);
  }
  const rows = trackIds.map((id, index) => buildRow({ id, index: index + 1, song: songMap.get(String(id)), playlistId, playlistName }));
  return { playlist: { id: playlistId, name: playlistName, apiTrackCount: detail.playlist.trackCount ?? null, trackIdsCount: trackIds.length, exportedCount: rows.length, missingDetailCount: rows.filter(row => row.status !== 'ok').length }, rows, warnings: [] };
}
