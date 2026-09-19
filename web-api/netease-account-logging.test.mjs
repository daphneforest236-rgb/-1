import assert from 'node:assert/strict';
import test from 'node:test';
import { runNeteaseAccountWorkerTestTask } from './netease-account.mjs';

test('worker-only sanitization never patches main-process console or exposes a fake sentinel', async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const tasks = [runNeteaseAccountWorkerTestTask(), runNeteaseAccountWorkerTestTask()];
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
  await Promise.all(tasks.map(task =>
    assert.rejects(task, error => {
      assert.equal(error.code, 'NETEASE_ACCOUNT_UPSTREAM_UNAVAILABLE');
      assert.equal(String(error.message).includes('FAKE_SECRET_COOKIE_SENTINEL'), false);
      assert.equal(String(error.code).includes('FAKE_SECRET_COOKIE_SENTINEL'), false);
      return true;
    })
  ));
  assert.equal(console.log, originalLog);
  assert.equal(console.error, originalError);
});
