import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { decryptNeteaseCredential, encryptNeteaseCredential, NeteaseCredentialError } from './netease-credential.mjs';

const originalKey = process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY;
process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const fakeCredential = 'FAKE_SESSION=only-for-test; FAKE_CSRF=only-for-test';

test.after(() => {
  if (originalKey === undefined) delete process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

test('encrypts and decrypts a synthetic credential with a user-bound AAD', () => {
  const encrypted = encryptNeteaseCredential('test-user-a', fakeCredential);
  assert.notEqual(encrypted.ciphertext, fakeCredential);
  assert.equal(decryptNeteaseCredential('test-user-a', encrypted), fakeCredential);
  assert.throws(() => decryptNeteaseCredential('test-user-b', encrypted), NeteaseCredentialError);
});

test('uses a fresh IV for each encryption', () => {
  const first = encryptNeteaseCredential('test-user-a', fakeCredential);
  const second = encryptNeteaseCredential('test-user-a', fakeCredential);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('fails closed for tampered ciphertext or auth tag', () => {
  const encrypted = encryptNeteaseCredential('test-user-a', fakeCredential);
  assert.throws(() => decryptNeteaseCredential('test-user-a', { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA` }), NeteaseCredentialError);
  assert.throws(() => decryptNeteaseCredential('test-user-a', { ...encrypted, authTag: `${encrypted.authTag.slice(0, -2)}AA` }), NeteaseCredentialError);
});

test('fails closed without a valid encryption key', () => {
  const encrypted = encryptNeteaseCredential('test-user-a', fakeCredential);
  delete process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY;
  assert.throws(() => decryptNeteaseCredential('test-user-a', encrypted), NeteaseCredentialError);
  process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
});
