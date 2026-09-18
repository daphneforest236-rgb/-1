import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { deleteNeteaseConnection, getNeteaseConnection, markNeteaseReconnectRequired, neteaseConnectionPayload, saveConnectedNeteaseConnection } from './netease-connections.mjs';
import { encryptNeteaseCredential } from './netease-credential.mjs';
import { query } from './db.mjs';

const originalKey = process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY;
process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const suffix = crypto.randomUUID();
const userA = `phase3f2-a-${suffix}`;
const userB = `phase3f2-b-${suffix}`;

test.before(async () => {
  await query('INSERT INTO app_users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)', [
    userA, `${userA}@example.test`, 'Phase 3F2 A', 'test-only-hash',
    userB, `${userB}@example.test`, 'Phase 3F2 B', 'test-only-hash'
  ]);
});

test.after(async () => {
  await query('DELETE FROM app_users WHERE id = ANY($1::text[])', [[userA, userB]]);
  if (originalKey === undefined) delete process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

test('connections remain scoped to their website user and reconnect rows retain no credential', async () => {
  const fakeCredential = 'FAKE_SESSION=phase3f2-test';
  await saveConnectedNeteaseConnection(userA, { uid: 'fake-a', nickname: 'Test A' }, encryptNeteaseCredential(userA, fakeCredential));
  await saveConnectedNeteaseConnection(userB, { uid: 'fake-b', nickname: 'Test B' }, encryptNeteaseCredential(userB, fakeCredential));

  assert.equal((await getNeteaseConnection(userA)).netease_uid, 'fake-a');
  assert.equal((await getNeteaseConnection(userB)).netease_uid, 'fake-b');
  const safePayload = neteaseConnectionPayload(await getNeteaseConnection(userA));
  for (const forbidden of ['credential_ciphertext', 'credential_iv', 'credential_auth_tag', 'credential_key_version']) {
    assert.equal(Object.hasOwn(safePayload, forbidden), false);
  }

  const reconnect = await markNeteaseReconnectRequired(userA, 'TEST_AUTH_INVALID');
  assert.equal(reconnect.status, 'reconnect_required');
  assert.equal(reconnect.credential_ciphertext, null);
  assert.equal(reconnect.credential_iv, null);
  assert.equal(reconnect.credential_auth_tag, null);
  assert.equal(reconnect.credential_key_version, null);

  await deleteNeteaseConnection(userA);
  assert.equal(await getNeteaseConnection(userA), null);
  assert.equal((await getNeteaseConnection(userB)).netease_uid, 'fake-b');
});
