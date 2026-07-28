import { createHash } from 'node:crypto';

function authorizationValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return null;
  return new Headers(value).get('authorization');
}

export function authorizationFingerprint(value = null) {
  const candidate = authorizationValue(value);
  const authorization = typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : 'anonymous';
  return createHash('sha256').update(authorization).digest('hex').slice(0, 16);
}
