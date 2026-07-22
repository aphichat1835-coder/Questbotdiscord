const ownerQueues = new Map();

/**
 * Serialize runner admission for one Discord owner. This keeps slot counting and
 * runner creation atomic relative to other /run or panel modal submissions from
 * the same owner, while allowing different owners to proceed independently.
 */
export async function withOwnerAdmissionLock(ownerId, operation) {
  if (!ownerId) throw new TypeError('ownerId is required');
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');

  const previous = ownerQueues.get(ownerId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  ownerQueues.set(ownerId, queued);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ownerQueues.get(ownerId) === queued) ownerQueues.delete(ownerId);
  }
}
