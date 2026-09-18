import assert from 'node:assert/strict';
import test from 'node:test';
import { clearAllNeteaseLoginAttempts, clearNeteaseLoginAttempt, createNeteaseLoginAttempt, getNeteaseLoginAttempt, neteaseLoginAttemptDebugCounts, updateNeteaseLoginAttempt } from './netease-login-attempts.mjs';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const emptyCounts = { attempts: 0, userIndexes: 0, expiredStatuses: 0 };

test('a pending QR attempt is owned by one website user and replaced by a newer attempt', () => {
  const first = createNeteaseLoginAttempt('test-user-a', 'fake-key-a');
  assert.equal(getNeteaseLoginAttempt('test-user-b', first.attemptId), null);
  const second = createNeteaseLoginAttempt('test-user-a', 'fake-key-b');
  assert.equal(getNeteaseLoginAttempt('test-user-a', first.attemptId), null);
  const owned = getNeteaseLoginAttempt('test-user-a', second.attemptId);
  assert.equal(owned.status, 'waiting_scan');
  updateNeteaseLoginAttempt(owned, 'waiting_confirm');
  assert.equal(getNeteaseLoginAttempt('test-user-a', second.attemptId).status, 'waiting_confirm');
  clearNeteaseLoginAttempt('test-user-b', second.attemptId);
  assert.ok(getNeteaseLoginAttempt('test-user-a', second.attemptId));
  clearAllNeteaseLoginAttempts('test-user-a');
  assert.equal(getNeteaseLoginAttempt('test-user-a', second.attemptId), null);
  assert.deepEqual(neteaseLoginAttemptDebugCounts(), emptyCounts);
});

test('an unpolled attempt actively expires, clears active indexes, and keeps only bounded expired status', async () => {
  const attempt = createNeteaseLoginAttempt('test-user-expiring', 'fake-key-expiring', { ttlMs: 20, expiredStatusTtlMs: 80 });
  await wait(45);
  assert.deepEqual(getNeteaseLoginAttempt('test-user-expiring', attempt.attemptId), { status: 'expired' });
  assert.deepEqual(neteaseLoginAttemptDebugCounts(), { attempts: 0, userIndexes: 0, expiredStatuses: 1 });
  await wait(70);
  assert.deepEqual(neteaseLoginAttemptDebugCounts(), emptyCounts);
});

test('an old expiration timer cannot remove a replacement attempt', async () => {
  createNeteaseLoginAttempt('test-user-replace', 'fake-key-old', { ttlMs: 20 });
  await wait(5);
  const replacement = createNeteaseLoginAttempt('test-user-replace', 'fake-key-new', { ttlMs: 70 });
  await wait(35);
  assert.ok(getNeteaseLoginAttempt('test-user-replace', replacement.attemptId));
  clearNeteaseLoginAttempt('test-user-replace', replacement.attemptId);
  assert.deepEqual(neteaseLoginAttemptDebugCounts(), emptyCounts);
});

test('success and disconnect cleanup leave no active attempt or timer index behind', () => {
  const success = createNeteaseLoginAttempt('test-user-success', 'fake-key-success');
  clearNeteaseLoginAttempt('test-user-success', success.attemptId);
  const disconnect = createNeteaseLoginAttempt('test-user-disconnect', 'fake-key-disconnect');
  clearAllNeteaseLoginAttempts('test-user-disconnect');
  assert.equal(getNeteaseLoginAttempt('test-user-disconnect', disconnect.attemptId), null);
  assert.deepEqual(neteaseLoginAttemptDebugCounts(), emptyCounts);
});
