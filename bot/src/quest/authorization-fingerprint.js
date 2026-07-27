import { createHash } from 'node:crypto';

export function authorizationFingerprint(value = '') {
  const authorization = typeof value === 'string'
    ? value
    : new Headers(value).get('authorization') ?? 'anonymous';
  return createHash('sha256').update(authorization).digest('hex').slice(0, 16);
}
