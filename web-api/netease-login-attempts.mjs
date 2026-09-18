import crypto from 'node:crypto';

const ATTEMPT_TTL_MS = 2 * 60 * 1000;
const EXPIRED_STATUS_TTL_MS = 30 * 1000;
const attempts = new Map();
const userAttemptIds = new Map();
const expiredStatuses = new Map();

function removeExpiredStatus(attemptId) {
  const status = expiredStatuses.get(attemptId);
  if (!status) return;
  if (status.expirationTimer) clearTimeout(status.expirationTimer);
  expiredStatuses.delete(attemptId);
}

function rememberExpiredStatus(attempt) {
  const status = {
    userId: attempt.userId,
    expirationTimer: null
  };
  status.expirationTimer = setTimeout(() => {
    if (expiredStatuses.get(attempt.attemptId) === status) removeExpiredStatus(attempt.attemptId);
  }, attempt.expiredStatusTtlMs);
  status.expirationTimer.unref?.();
  expiredStatuses.set(attempt.attemptId, status);
}

function removeAttempt(attemptId) {
  const attempt = attempts.get(attemptId);
  if (!attempt) return;
  if (attempt.expirationTimer) clearTimeout(attempt.expirationTimer);
  attempts.delete(attemptId);
  if (userAttemptIds.get(attempt.userId) === attemptId) userAttemptIds.delete(attempt.userId);
}

function isExpired(attempt) {
  return attempt.expiresAt <= Date.now();
}

export function createNeteaseLoginAttempt(userId, qrKey, { ttlMs = ATTEMPT_TTL_MS, expiredStatusTtlMs = EXPIRED_STATUS_TTL_MS } = {}) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedQrKey = String(qrKey || '').trim();
  const effectiveTtlMs = Number(ttlMs);
  const effectiveExpiredStatusTtlMs = Number(expiredStatusTtlMs);
  if (!normalizedUserId || !normalizedQrKey || !Number.isInteger(effectiveTtlMs) || effectiveTtlMs < 1 || !Number.isInteger(effectiveExpiredStatusTtlMs) || effectiveExpiredStatusTtlMs < 1) {
    throw new Error('网易云二维码登录尝试无效。');
  }
  const existingId = userAttemptIds.get(normalizedUserId);
  if (existingId) removeAttempt(existingId);
  const attemptId = crypto.randomUUID();
  const attempt = {
    attemptId,
    userId: normalizedUserId,
    qrKey: normalizedQrKey,
    status: 'waiting_scan',
    expiresAt: Date.now() + effectiveTtlMs,
    expiredStatusTtlMs: effectiveExpiredStatusTtlMs,
    expirationTimer: null
  };
  attempt.expirationTimer = setTimeout(() => {
    // A replaced attempt owns a different object. Never let an old timer
    // delete the newer attempt occupying the same user index.
    if (attempts.get(attemptId) === attempt) {
      removeAttempt(attemptId);
      rememberExpiredStatus(attempt);
    }
  }, effectiveTtlMs);
  attempt.expirationTimer.unref?.();
  attempts.set(attemptId, attempt);
  userAttemptIds.set(normalizedUserId, attemptId);
  return { attemptId, expiresAt: new Date(attempt.expiresAt).toISOString() };
}

export function getNeteaseLoginAttempt(userId, attemptId) {
  const normalizedAttemptId = String(attemptId || '');
  const normalizedUserId = String(userId || '');
  const attempt = attempts.get(normalizedAttemptId);
  if (!attempt) {
    const expired = expiredStatuses.get(normalizedAttemptId);
    return expired && expired.userId === normalizedUserId ? { status: 'expired' } : null;
  }
  if (attempt.userId !== normalizedUserId) return null;
  if (isExpired(attempt)) {
    removeAttempt(attempt.attemptId);
    rememberExpiredStatus(attempt);
    return { status: 'expired' };
  }
  return attempt;
}

export function updateNeteaseLoginAttempt(attempt, status) {
  if (!attempts.has(attempt?.attemptId)) return;
  attempt.status = status;
}

export function clearNeteaseLoginAttempt(userId, attemptId) {
  const attempt = attempts.get(String(attemptId || ''));
  if (attempt && attempt.userId === String(userId || '')) removeAttempt(attempt.attemptId);
}

export function clearAllNeteaseLoginAttempts(userId) {
  const attemptId = userAttemptIds.get(String(userId || ''));
  if (attemptId) removeAttempt(attemptId);
}

// Test-only observability: this is not imported by server.mjs or exposed by an API.
export function neteaseLoginAttemptDebugCounts() {
  return { attempts: attempts.size, userIndexes: userAttemptIds.size, expiredStatuses: expiredStatuses.size };
}

export const NETEASE_LOGIN_ATTEMPT_TTL_MS = ATTEMPT_TTL_MS;
