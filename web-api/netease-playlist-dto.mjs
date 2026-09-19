export const DEFAULT_PLAYLIST_LIMIT = 30;
export const MAX_PLAYLIST_LIMIT = 100;

export class NeteaseUserPlaylistError extends Error {
  constructor(code, message, { status = 502, cause } = {}) {
    super(message);
    this.name = 'NeteaseUserPlaylistError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function invalidPagination() {
  return new NeteaseUserPlaylistError('INVALID_PAGINATION', '分页参数无效。', { status: 400 });
}

function parseNonNegativeInteger(value, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw invalidPagination();
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw invalidPagination();
  return number;
}

export function parsePlaylistPagination(searchParams) {
  return {
    limit: parseNonNegativeInteger(searchParams.get('limit'), DEFAULT_PLAYLIST_LIMIT, { minimum: 1, maximum: MAX_PLAYLIST_LIMIT }),
    offset: parseNonNegativeInteger(searchParams.get('offset'), 0)
  };
}

function playlistDto(raw) {
  const sourceId = raw?.id == null ? '' : String(raw.id).trim();
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  const trackCount = Number(raw?.trackCount);
  if (!sourceId || !name || !Number.isSafeInteger(trackCount) || trackCount < 0) return null;
  const coverUrl = typeof raw?.coverImgUrl === 'string' && raw.coverImgUrl.trim()
    ? raw.coverImgUrl.trim()
    : null;
  return { source: 'netease', sourceId, name, trackCount, coverUrl };
}

export function normalizeNeteaseUserPlaylistResponse(body, { limit, offset }) {
  if (!body || !Array.isArray(body.playlist)) {
    throw new NeteaseUserPlaylistError('NETEASE_PLAYLIST_RESPONSE_INVALID', '网易云歌单列表返回无效。');
  }
  // The upstream endpoint may return more than the requested limit. Preserve
  // its offset boundary by taking this raw page before filtering malformed
  // entries into safe browser DTOs; never refill from later raw entries.
  const rawPage = body.playlist.slice(0, limit);
  const total = Number(body.total);
  return {
    items: rawPage.map(playlistDto).filter(Boolean),
    total: Number.isSafeInteger(total) && total >= 0 ? total : null,
    more: body.playlist.length > limit
      ? true
      : typeof body.more === 'boolean' ? body.more : null,
    limit,
    offset
  };
}
