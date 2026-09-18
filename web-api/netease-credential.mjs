import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_VERSION = 1;
const FORMAT_VERSION = 'netease-cookie-v1';

export class NeteaseCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NeteaseCredentialError';
    this.code = code;
  }
}

function credentialKey() {
  const encoded = String(process.env.NETEASE_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!encoded) {
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_ENCRYPTION_UNAVAILABLE', '网易云连接服务尚未完成安全配置。');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_ENCRYPTION_UNAVAILABLE', '网易云连接服务尚未完成安全配置。');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encoded) {
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_ENCRYPTION_UNAVAILABLE', '网易云连接服务尚未完成安全配置。');
  }
  return key;
}

function aadForUser(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', '网站账号标识无效。');
  return Buffer.from(`${FORMAT_VERSION}:user:${normalizedUserId}`, 'utf8');
}

function decodeBase64(value, field, { allowEmpty = false } = {}) {
  const encoded = String(value || '');
  if ((!allowEmpty && !encoded) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', `网易云连接凭据${field}无效。`);
  }
  const decoded = Buffer.from(encoded, 'base64');
  if ((!allowEmpty && !decoded.length) || decoded.toString('base64') !== encoded) {
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', `网易云连接凭据${field}无效。`);
  }
  return decoded;
}

export function assertNeteaseCredentialEncryptionConfigured() {
  credentialKey();
}

export function encryptNeteaseCredential(userId, plaintextCredential) {
  const plaintext = String(plaintextCredential || '');
  if (!plaintext) throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', '网易云连接凭据为空。');
  const key = credentialKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  cipher.setAAD(aadForUser(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: KEY_VERSION
  };
}

export function decryptNeteaseCredential(userId, encrypted) {
  if (Number(encrypted?.keyVersion) !== KEY_VERSION) {
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', '网易云连接凭据版本无效。');
  }
  const key = credentialKey();
  const iv = decodeBase64(encrypted?.iv, '初始化向量');
  const authTag = decodeBase64(encrypted?.authTag, '认证标签');
  const ciphertext = decodeBase64(encrypted?.ciphertext, '密文');
  if (iv.length !== IV_BYTES || authTag.length !== 16) {
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', '网易云连接凭据格式无效。');
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAAD(aadForUser(userId));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (!plaintext) throw new Error('empty');
    return plaintext;
  } catch (error) {
    if (error instanceof NeteaseCredentialError) throw error;
    throw new NeteaseCredentialError('NETEASE_CREDENTIAL_INVALID', '网易云连接凭据无法验证。');
  }
}
