import { query, transaction } from './db.mjs';

const selectedColumns = `user_id, netease_uid, netease_nickname, status,
  credential_ciphertext, credential_iv, credential_auth_tag, credential_key_version,
  connected_at, updated_at, last_verified_at, last_error_code`;

export async function getNeteaseConnection(userId) {
  const result = await query(`SELECT ${selectedColumns} FROM netease_connections WHERE user_id = $1`, [userId]);
  return result.rows[0] || null;
}

export async function saveConnectedNeteaseConnection(userId, account, encrypted) {
  return transaction(async client => {
    const result = await client.query(
      `INSERT INTO netease_connections (
        user_id, netease_uid, netease_nickname, status,
        credential_ciphertext, credential_iv, credential_auth_tag, credential_key_version,
        connected_at, updated_at, last_verified_at, last_error_code
      ) VALUES ($1, $2, $3, 'connected', $4, $5, $6, $7, now(), now(), now(), NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        netease_uid = EXCLUDED.netease_uid,
        netease_nickname = EXCLUDED.netease_nickname,
        status = 'connected',
        credential_ciphertext = EXCLUDED.credential_ciphertext,
        credential_iv = EXCLUDED.credential_iv,
        credential_auth_tag = EXCLUDED.credential_auth_tag,
        credential_key_version = EXCLUDED.credential_key_version,
        connected_at = now(), updated_at = now(), last_verified_at = now(), last_error_code = NULL
      RETURNING ${selectedColumns}`,
      [userId, account.uid, account.nickname, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion]
    );
    return result.rows[0];
  });
}

export async function touchVerifiedNeteaseConnection(userId, account) {
  const result = await query(
    `UPDATE netease_connections
        SET netease_uid = $1, netease_nickname = $2, updated_at = now(), last_verified_at = now(), last_error_code = NULL
      WHERE user_id = $3 AND status = 'connected'
      RETURNING ${selectedColumns}`,
    [account.uid, account.nickname, userId]
  );
  return result.rows[0] || null;
}

export async function markNeteaseReconnectRequired(userId, errorCode) {
  const result = await query(
    `UPDATE netease_connections
        SET status = 'reconnect_required', credential_ciphertext = NULL, credential_iv = NULL,
            credential_auth_tag = NULL, credential_key_version = NULL,
            updated_at = now(), last_error_code = $2
      WHERE user_id = $1
      RETURNING ${selectedColumns}`,
    [userId, String(errorCode || 'NETEASE_ACCOUNT_AUTH_INVALID').slice(0, 80)]
  );
  return result.rows[0] || null;
}

export async function deleteNeteaseConnection(userId) {
  await query('DELETE FROM netease_connections WHERE user_id = $1', [userId]);
}

export function neteaseConnectionPayload(row) {
  if (!row) return { status: 'disconnected' };
  const payload = {
    status: row.status,
    account: row.netease_uid ? { uid: String(row.netease_uid), nickname: row.netease_nickname || null } : null,
    connectedAt: row.connected_at,
    lastVerifiedAt: row.last_verified_at
  };
  return payload;
}
