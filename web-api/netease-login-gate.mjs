import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This is an isolated, local-only feasibility gate.  It never starts an HTTP
// server, touches PostgreSQL, or persists the account session.
for (const name of [
  'NETEASE_COOKIE',
  'ENABLE_RANDOM_CN_IP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy'
]) {
  delete process.env[name];
}

// The package loads its own environment helper during require(), so this must
// happen after the process-level cleanup above.
const require = createRequire(import.meta.url);
const neteaseApi = require('@neteasecloudmusicapienhanced/api');

const QR_PATH = join(tmpdir(), 'ktv-phase3f-netease-login-gate.png');
const POLL_INTERVAL_MS = 4_000;
const MAX_POLLS = 30;
const REQUEST_TIMEOUT_MS = 10_000;

function safeMessage(value) {
  return String(value || '未提供错误信息')
    .replace(/(?:MUSIC_U|csrf|cookie|token)\s*=[^;\s,]+/gi, '[已脱敏]')
    .slice(0, 240);
}

function gateOptions(cookie = {}) {
  return {
    cookie,
    crypto: 'weapi',
    randomCNIP: false,
    checkToken: false,
    timeout: REQUEST_TIMEOUT_MS
  };
}

async function removeQr() {
  try {
    rmSync(QR_PATH, { force: true });
  } catch {}
}

async function fail(stage, responseOrError) {
  const status = Number(responseOrError?.status) || 'unknown';
  const body = responseOrError?.body || {};
  const code = body.code ?? 'unknown';
  const message = safeMessage(body.message || body.msg || responseOrError?.message);
  console.log(`LOGIN_GATE_FAIL stage=${stage} http=${status} code=${code} message=${message}`);
  await removeQr();
  process.exitCode = 1;
}

async function main() {
  let loginCookie = '';
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    loginCookie = '';
    await removeQr();
  };

  process.once('SIGINT', () => {
    loginCookie = '';
    try {
      rmSync(QR_PATH, { force: true });
    } catch {}
    process.exit(130);
  });

  try {
    const keyResponse = await neteaseApi.login_qr_key(gateOptions());
    const key = keyResponse?.body?.data?.unikey;
    if (keyResponse?.status !== 200 || !key) {
      await fail('key', keyResponse);
      return;
    }

    const qrResponse = await neteaseApi.login_qr_create({
      ...gateOptions(),
      key,
      qrimg: true
    });
    const qrImage = qrResponse?.body?.data?.qrimg;
    if (qrResponse?.status !== 200 || typeof qrImage !== 'string' || !qrImage.startsWith('data:image/')) {
      await fail('create', qrResponse);
      return;
    }

    const base64 = qrImage.slice(qrImage.indexOf(',') + 1);
    await writeFile(QR_PATH, Buffer.from(base64, 'base64'), { mode: 0o600 });
    console.log('QR_CREATED');

    let lastState = '';
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      const check = await neteaseApi.login_qr_check({ ...gateOptions(), key });
      const code = Number(check?.body?.code);

      if (check?.status !== 200) {
        await fail('check', check);
        return;
      }
      if (code === 801) {
        if (lastState !== 'WAITING_SCAN') console.log('WAITING_SCAN');
        lastState = 'WAITING_SCAN';
      } else if (code === 802) {
        if (lastState !== 'WAITING_CONFIRM') console.log('WAITING_CONFIRM');
        lastState = 'WAITING_CONFIRM';
      } else if (code === 803) {
        const cookies = Array.isArray(check.cookie) ? check.cookie : [];
        loginCookie = cookies.join(';');
        if (!loginCookie) {
          await fail('check', { status: check.status, body: { code, message: '登录成功响应未提供会话状态。' } });
          return;
        }

        const account = await neteaseApi.user_account(gateOptions(loginCookie));
        const profile = account?.body?.profile;
        const uid = profile?.userId ?? account?.body?.account?.id;
        const nickname = profile?.nickname;
        if (account?.status !== 200 || Number(account?.body?.code) !== 200 || uid == null || !nickname) {
          await fail('identity', account);
          return;
        }
        console.log('LOGIN_SUCCESS');
        console.log(`uid: ${String(uid)}`);
        console.log(`nickname: ${String(nickname).replace(/[\r\n]/g, ' ').slice(0, 100)}`);
        await cleanup();
        return;
      } else if (code === 800) {
        await fail('check', { status: check.status, body: { code, message: '二维码已过期。' } });
        return;
      } else {
        await fail('check', check);
        return;
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    await fail('check', { status: 200, body: { code: 'POLL_TIMEOUT', message: '等待扫码超时，未继续重试。' } });
  } catch (error) {
    await fail('unexpected', error);
  } finally {
    loginCookie = '';
  }
}

await main();
