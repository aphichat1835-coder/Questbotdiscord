import { createHash } from 'node:crypto';

export function authorizationFingerprint(value = null) {
  const candidate = typeof value === 'string'
    ? value
    : value == null
      ? null
      : new Headers(value).get('authorization');
  const authorization = typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : 'anonymous';
  return createHash('sha256').update(authorization).digest('hex').slice(0, 16);
}
