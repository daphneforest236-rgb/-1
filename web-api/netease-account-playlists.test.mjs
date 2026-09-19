import assert from 'node:assert/strict';
import test from 'node:test';
import { listCurrentUserNeteasePlaylists } from './netease-account-playlists.mjs';
import { NeteaseAccountError } from './netease-account.mjs';
import { NeteaseCredentialError } from './netease-credential.mjs';
import { NeteaseUserPlaylistError, normalizeNeteaseUserPlaylistResponse, parsePlaylistPagination } from './netease-playlist-dto.mjs';

test('playlist pagination has explicit safe defaults and bounds', () => {
  assert.deepEqual(parsePlaylistPagination(new URLSearchParams()), { limit: 30, offset: 0 });
  assert.deepEqual(parsePlaylistPagination(new URLSearchParams('limit=100&offset=50')), { limit: 100, offset: 50 });
  for (const input of ['limit=0', 'limit=-1', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=1.5']) {
    assert.throws(() => parsePlaylistPagination(new URLSearchParams(input)), error => error.code === 'INVALID_PAGINATION');
  }
});

test('playlist DTO uses only safe fields and safely handles optional pagination fields', () => {
  const result = normalizeNeteaseUserPlaylistResponse({
    playlist: [
      { id: 123, name: 'FAKE PLAYLIST', trackCount: 4, coverImgUrl: 'https://example.test/cover.jpg', creator: { userId: 'FAKE' } },
      { id: null, name: 'invalid', trackCount: 1 },
      { id: 456, name: 'invalid count', trackCount: -1 }
    ],
    total: 1,
    more: true
  }, { limit: 30, offset: 0 });
  assert.deepEqual(result, {
    items: [{ source: 'netease', sourceId: '123', name: 'FAKE PLAYLIST', trackCount: 4, coverUrl: 'https://example.test/cover.jpg' }],
    total: 1,
    more: true,
    limit: 30,
    offset: 0
  });
  assert.deepEqual(normalizeNeteaseUserPlaylistResponse({ playlist: [] }, { limit: 30, offset: 0 }), {
    items: [], total: null, more: null, limit: 30, offset: 0
  });
  assert.throws(() => normalizeNeteaseUserPlaylistResponse({ playlist: {} }, { limit: 30, offset: 0 }), error => error.code === 'NETEASE_PLAYLIST_RESPONSE_INVALID');
});

function rawPlaylist(ids) {
  return ids.map(id => ({ id, name: `FAKE PLAYLIST ${id}`, trackCount: 1 }));
}

test('raw upstream page is limited before DTO mapping and drives more', () => {
  const upstreamOverflow = normalizeNeteaseUserPlaylistResponse({
    playlist: rawPlaylist(Array.from({ length: 46 }, (_, index) => index + 1)),
    more: false
  }, { limit: 5, offset: 0 });
  assert.equal(upstreamOverflow.items.length, 5);
  assert.equal(upstreamOverflow.more, true);

  assert.equal(normalizeNeteaseUserPlaylistResponse({
    playlist: rawPlaylist([1, 2, 3, 4, 5]),
    more: false
  }, { limit: 5, offset: 0 }).more, false);
  assert.equal(normalizeNeteaseUserPlaylistResponse({
    playlist: rawPlaylist([1, 2, 3, 4, 5]),
    more: true
  }, { limit: 5, offset: 0 }).more, true);

  const noUpstreamMore = normalizeNeteaseUserPlaylistResponse({
    playlist: rawPlaylist([1, 2, 3])
  }, { limit: 5, offset: 0 });
  assert.equal(noUpstreamMore.items.length, 3);
  assert.equal(noUpstreamMore.more, null);
});

test('malformed entries cannot pull later raw items across a page boundary', () => {
  const result = normalizeNeteaseUserPlaylistResponse({
    playlist: [
      { id: 'A', name: 'A', trackCount: 1 },
      { id: 'B', name: 'B', trackCount: 1 },
      { id: null, name: 'MALFORMED', trackCount: 1 },
      { id: 'C', name: 'C', trackCount: 1 },
      { id: 'D', name: 'D', trackCount: 1 },
      { id: 'E', name: 'E', trackCount: 1 }
    ]
  }, { limit: 5, offset: 0 });
  assert.deepEqual(result.items.map(item => item.sourceId), ['A', 'B', 'C', 'D']);
  assert.equal(result.more, true);
});

test('upstream offset is not applied again to its returned raw page', () => {
  const result = normalizeNeteaseUserPlaylistResponse({
    playlist: rawPlaylist(['UPSTREAM-6', 'UPSTREAM-7', 'UPSTREAM-8', 'UPSTREAM-9', 'UPSTREAM-10']),
    more: true
  }, { limit: 5, offset: 5 });
  assert.deepEqual(result.items.map(item => item.sourceId), ['UPSTREAM-6', 'UPSTREAM-7', 'UPSTREAM-8', 'UPSTREAM-9', 'UPSTREAM-10']);
  assert.equal(result.offset, 5);
});

test('playlist reads use only the current website user connection and never a browser uid', async () => {
  const calls = [];
  const connections = {
    'website-a': { status: 'connected', netease_uid: 'FAKE_NETEASE_A', credential_ciphertext: 'a', credential_iv: 'b', credential_auth_tag: 'c', credential_key_version: 1 },
    'website-b': { status: 'connected', netease_uid: 'FAKE_NETEASE_B', credential_ciphertext: 'a', credential_iv: 'b', credential_auth_tag: 'c', credential_key_version: 1 }
  };
  const services = {
    getNeteaseConnection: async userId => connections[userId] || null,
    decryptNeteaseCredential: userId => `FAKE_SECRET_COOKIE_SENTINEL_${userId}`,
    getUserPlaylists: async (uid, credential, limit, offset) => {
      calls.push({ uid, credentialPresent: Boolean(credential), limit, offset });
      return { items: [], total: null, more: null, limit, offset };
    },
    markNeteaseReconnectRequired: async () => { throw new Error('should not mark'); }
  };
  await listCurrentUserNeteasePlaylists('website-a', { limit: 20, offset: 0 }, services);
  await listCurrentUserNeteasePlaylists('website-b', { limit: 10, offset: 10 }, services);
  assert.deepEqual(calls, [
    { uid: 'FAKE_NETEASE_A', credentialPresent: true, limit: 20, offset: 0 },
    { uid: 'FAKE_NETEASE_B', credentialPresent: true, limit: 10, offset: 10 }
  ]);
});

test('disconnected and reconnect states are controlled and do not call NetEase', async () => {
  for (const connection of [null, { status: 'reconnect_required' }]) {
    let called = false;
    await assert.rejects(
      listCurrentUserNeteasePlaylists('website-a', { limit: 30, offset: 0 }, {
        getNeteaseConnection: async () => connection,
        getUserPlaylists: async () => { called = true; }
      }),
      error => error instanceof NeteaseUserPlaylistError && ['NETEASE_DISCONNECTED', 'NETEASE_RECONNECT_REQUIRED'].includes(error.code)
    );
    assert.equal(called, false);
  }
});

test('invalid credential or confirmed auth failure requires reconnect without leaking synthetic credential', async () => {
  const connection = { status: 'connected', netease_uid: 'FAKE_NETEASE_A', credential_ciphertext: 'a', credential_iv: 'b', credential_auth_tag: 'c', credential_key_version: 1 };
  for (const scenario of ['decrypt', 'auth']) {
    const marked = [];
    const services = {
      getNeteaseConnection: async () => connection,
      decryptNeteaseCredential: () => {
        if (scenario === 'decrypt') throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', 'FAKE_SECRET_COOKIE_SENTINEL');
        return 'FAKE_SECRET_COOKIE_SENTINEL';
      },
      getUserPlaylists: async () => {
        throw new NeteaseAccountError('NETEASE_ACCOUNT_AUTH_INVALID', 'FAKE_SECRET_COOKIE_SENTINEL', { kind: 'auth' });
      },
      markNeteaseReconnectRequired: async (_userId, code) => marked.push(code)
    };
    await assert.rejects(listCurrentUserNeteasePlaylists('website-a', { limit: 30, offset: 0 }, services), error => {
      assert.equal(error.code, 'NETEASE_RECONNECT_REQUIRED');
      assert.equal(String(error.message).includes('FAKE_SECRET_COOKIE_SENTINEL'), false);
      return true;
    });
    assert.equal(marked.length, 1);
  }
});

test('temporary upstream failure preserves the connection state', async () => {
  let marked = false;
  await assert.rejects(listCurrentUserNeteasePlaylists('website-a', { limit: 30, offset: 0 }, {
    getNeteaseConnection: async () => ({ status: 'connected', netease_uid: 'FAKE_NETEASE_A', credential_ciphertext: 'a', credential_iv: 'b', credential_auth_tag: 'c', credential_key_version: 1 }),
    decryptNeteaseCredential: () => 'FAKE_SECRET_COOKIE_SENTINEL',
    getUserPlaylists: async () => { throw new NeteaseAccountError('NETEASE_ACCOUNT_TIMEOUT', 'FAKE_SECRET_COOKIE_SENTINEL'); },
    markNeteaseReconnectRequired: async () => { marked = true; }
  }), error => error.code === 'NETEASE_ACCOUNT_TIMEOUT' && !String(error.message).includes('FAKE_SECRET_COOKIE_SENTINEL'));
  assert.equal(marked, false);
});
