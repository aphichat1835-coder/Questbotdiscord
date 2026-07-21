import path from 'node:path';

function assertSimpleName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('Path name must be a non-empty string');
  }
  if (path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error(`Unsafe path name: ${name}`);
  }
}

export function resolveContainedPath(directory, name) {
  assertSimpleName(name);
  const root = path.resolve(directory);
  const candidate = path.resolve(root, name);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Resolved path escapes its directory: ${name}`);
  }
  return candidate;
}

export function appendSafeSuffix(filePath, suffix) {
  if (typeof suffix !== 'string' || !suffix || suffix.includes('/') || suffix.includes('\\')) {
    throw new Error('Unsafe path suffix');
  }
  const absoluteFile = path.resolve(filePath);
  return resolveContainedPath(
    path.dirname(absoluteFile),
    `${path.basename(absoluteFile)}${suffix}`,
  );
}
