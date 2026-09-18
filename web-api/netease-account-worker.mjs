import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

// This is intentionally a worker-local boundary. The main HTTP process never
// patches global console methods. It runs before loading the third-party API.
console.log = () => {};
console.error = () => {};

const require = createRequire(import.meta.url);
const neteaseApi = require('@neteasecloudmusicapienhanced/api');
const REQUEST_TIMEOUT_MS = 10_000;

function requestOptions(cookie = {}) {
  return { cookie, crypto: 'weapi', randomCNIP: false, checkToken: false, timeout: REQUEST_TIMEOUT_MS };
}

function safeFailure(code = 'NETEASE_ACCOUNT_UPSTREAM_UNAVAILABLE') {
  return { ok: false, error: { code } };
}

function readAccountIdentity(response) {
  const profile = response?.body?.profile;
  const account = response?.body?.account;
  const uid = profile?.userId ?? account?.id;
  const nickname = profile?.nickname;
  if (response?.status !== 200 || response?.body?.code !== 200) throw new Error('upstream');
  if (uid == null || !nickname || account?.anonimousUser === true) {
    const error = new Error('auth');
    error.code = 'NETEASE_ACCOUNT_AUTH_INVALID';
    throw error;
  }
  return { uid: String(uid), nickname: String(nickname).slice(0, 200) };
}

async function createQr() {
  const keyResponse = await neteaseApi.login_qr_key(requestOptions());
  const qrKey = String(keyResponse?.body?.data?.unikey || '').trim();
  if (keyResponse?.status !== 200 || !qrKey) throw new Error('qr_key');
  const qrResponse = await neteaseApi.login_qr_create({ ...requestOptions(), key: qrKey, qrimg: true });
  const qrImage = String(qrResponse?.body?.data?.qrimg || '');
  if (qrResponse?.status !== 200 || !qrImage.startsWith('data:image/')) throw new Error('qr_create');
  return { qrKey, qrImage };
}

async function checkQr(qrKey) {
  const result = await neteaseApi.login_qr_check({ ...requestOptions(), key: String(qrKey || '') });
  const code = Number(result?.body?.code);
  if (result?.status !== 200) throw new Error('qr_check');
  if (code === 801) return { status: 'waiting_scan' };
  if (code === 802) return { status: 'waiting_confirm' };
  if (code === 800) return { status: 'expired' };
  if (code !== 803) return { status: 'failed' };
  const credential = Array.isArray(result.cookie) ? result.cookie.join(';') : '';
  if (!credential) throw new Error('credential_missing');
  const accountResponse = await neteaseApi.user_account(requestOptions(credential));
  return { status: 'connected', credential, account: readAccountIdentity(accountResponse) };
}

async function accountForCredential(credential) {
  const response = await neteaseApi.user_account(requestOptions(String(credential || '')));
  return { account: readAccountIdentity(response) };
}

async function main() {
  const { task, payload, testMode } = workerData || {};
  if (task === 'test_log_sentinel' && testMode === true) {
    console.log('FAKE_SECRET_COOKIE_SENTINEL');
    console.error('FAKE_SECRET_COOKIE_SENTINEL');
    throw new Error('FAKE_SECRET_COOKIE_SENTINEL');
  }
  if (task === 'create_qr') return createQr();
  if (task === 'check_qr') return checkQr(payload?.qrKey);
  if (task === 'user_account') return accountForCredential(payload?.credential);
  throw new Error('unsupported_task');
}

main()
  .then(result => parentPort.postMessage({ ok: true, result }))
  .catch(error => parentPort.postMessage(safeFailure(error?.code)));
