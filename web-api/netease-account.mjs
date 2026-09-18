import { Worker } from 'node:worker_threads';

const REQUEST_TIMEOUT_MS = 12_000;
const workerUrl = new URL('./netease-account-worker.mjs', import.meta.url);

function workerEnvironment() {
  // The upstream package uses os.tmpdir() for its anonymous-session state.
  // Pass only the OS temp-directory variables it needs; do not inherit cookies,
  // proxy configuration, or arbitrary application secrets into the worker.
  const env = {};
  for (const name of ['TEMP', 'TMP', 'SystemRoot', 'WINDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

export class NeteaseAccountError extends Error {
  constructor(code, message, { status = 502, kind = 'temporary', cause } = {}) {
    super(message);
    this.name = 'NeteaseAccountError';
    this.code = code;
    this.status = status;
    this.kind = kind;
    this.cause = cause;
  }
}

function accountErrorFromWorker(error) {
  const code = String(error?.code || 'NETEASE_ACCOUNT_UPSTREAM_UNAVAILABLE');
  if (code === 'NETEASE_ACCOUNT_AUTH_INVALID') {
    return new NeteaseAccountError(code, '网易云账号连接已失效。', { status: 401, kind: 'auth' });
  }
  return new NeteaseAccountError(code, '网易云账号服务暂时不可用。');
}

function runAccountWorker(task, payload = {}, { testMode = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerUrl, {
      // Credentials use only in-memory message passing, never arguments or env.
      env: workerEnvironment(),
      // Do not inherit parent-only flags such as --test or --input-type.
      execArgv: [],
      stdout: true,
      stderr: true,
      workerData: { task, payload, testMode }
    });
    // Never forward worker output to the main process.
    worker.stdout.resume();
    worker.stderr.resume();

    const timeout = setTimeout(() => finish(accountErrorFromWorker({ code: 'NETEASE_ACCOUNT_TIMEOUT' })), REQUEST_TIMEOUT_MS);
    timeout.unref?.();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value);
    }

    worker.once('message', message => {
      if (message?.ok) return finish(null, message.result);
      return finish(accountErrorFromWorker(message?.error));
    });
    worker.once('error', () => finish(accountErrorFromWorker({ code: 'NETEASE_ACCOUNT_WORKER_FAILED' })));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(accountErrorFromWorker({ code: 'NETEASE_ACCOUNT_WORKER_FAILED' }));
    });
  });
}

export async function createQrLogin() {
  const result = await runAccountWorker('create_qr');
  if (!result?.qrKey || !String(result.qrImage || '').startsWith('data:image/')) {
    throw new NeteaseAccountError('NETEASE_QR_CREATE_FAILED', '网易云二维码创建失败。');
  }
  return result;
}

export async function checkQrLogin(qrKey) {
  const result = await runAccountWorker('check_qr', { qrKey: String(qrKey || '') });
  if (!['waiting_scan', 'waiting_confirm', 'connected', 'expired', 'failed'].includes(result?.status)) {
    throw new NeteaseAccountError('NETEASE_QR_CHECK_FAILED', '网易云二维码状态查询失败。');
  }
  if (result.status === 'connected' && (!result.credential || !result.account?.uid || !result.account?.nickname)) {
    throw new NeteaseAccountError('NETEASE_QR_CREDENTIAL_MISSING', '网易云登录状态无效。');
  }
  return result;
}

export async function getAuthenticatedAccount(credential) {
  if (!String(credential || '')) {
    throw new NeteaseAccountError('NETEASE_ACCOUNT_AUTH_INVALID', '网易云账号连接已失效。', {
      status: 401,
      kind: 'auth'
    });
  }
  const result = await runAccountWorker('user_account', { credential: String(credential) });
  if (!result?.account?.uid || !result.account?.nickname) {
    throw new NeteaseAccountError('NETEASE_ACCOUNT_AUTH_INVALID', '网易云账号连接已失效。', {
      status: 401,
      kind: 'auth'
    });
  }
  return result.account;
}

// Test-only task, never imported by server.mjs or exposed as an HTTP route.
export function runNeteaseAccountWorkerTestTask() {
  return runAccountWorker('test_log_sentinel', {}, { testMode: true });
}
