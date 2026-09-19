import { getUserPlaylists, NeteaseAccountError } from './netease-account.mjs';
import { decryptNeteaseCredential, NeteaseCredentialError } from './netease-credential.mjs';
import { getNeteaseConnection, markNeteaseReconnectRequired } from './netease-connections.mjs';
import { NeteaseUserPlaylistError } from './netease-playlist-dto.mjs';

const defaults = { getUserPlaylists, decryptNeteaseCredential, getNeteaseConnection, markNeteaseReconnectRequired };

function stateError(code, message) {
  return new NeteaseUserPlaylistError(code, message, { status: 409 });
}

export async function listCurrentUserNeteasePlaylists(userId, pagination, overrides = {}) {
  const services = { ...defaults, ...overrides };
  const connection = await services.getNeteaseConnection(userId);
  if (!connection) throw stateError('NETEASE_DISCONNECTED', '请先连接网易云账号。');
  if (connection.status === 'reconnect_required') {
    throw stateError('NETEASE_RECONNECT_REQUIRED', '网易云账号需要重新连接。');
  }
  if (connection.status !== 'connected') {
    throw stateError('NETEASE_RECONNECT_REQUIRED', '网易云账号需要重新连接。');
  }

  let credential = '';
  try {
    credential = services.decryptNeteaseCredential(userId, {
      ciphertext: connection.credential_ciphertext,
      iv: connection.credential_iv,
      authTag: connection.credential_auth_tag,
      keyVersion: connection.credential_key_version
    });
  } catch (error) {
    if (error instanceof NeteaseCredentialError && error.code === 'NETEASE_CREDENTIAL_ENCRYPTION_UNAVAILABLE') throw error;
    await services.markNeteaseReconnectRequired(userId, error?.code);
    throw stateError('NETEASE_RECONNECT_REQUIRED', '网易云账号需要重新连接。');
  }

  try {
    return await services.getUserPlaylists(connection.netease_uid, credential, pagination.limit, pagination.offset);
  } catch (error) {
    if (error instanceof NeteaseAccountError && error.kind === 'auth') {
      await services.markNeteaseReconnectRequired(userId, error.code);
      throw stateError('NETEASE_RECONNECT_REQUIRED', '网易云账号需要重新连接。');
    }
    if (error instanceof NeteaseAccountError && error.code === 'NETEASE_PLAYLIST_RESPONSE_INVALID') {
      throw new NeteaseUserPlaylistError(error.code, '网易云歌单列表返回无效。');
    }
    if (error instanceof NeteaseAccountError && error.code === 'NETEASE_ACCOUNT_TIMEOUT') {
      throw new NeteaseUserPlaylistError(error.code, '网易云歌单列表请求超时。', { status: 504, cause: error });
    }
    throw new NeteaseUserPlaylistError('NETEASE_ACCOUNT_UPSTREAM_UNAVAILABLE', '网易云歌单列表暂时不可用。', { cause: error });
  } finally {
    credential = '';
  }
}
