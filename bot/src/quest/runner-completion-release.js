function safeRelease(release, onError) {
  try {
    release();
  } catch (error) {
    onError(error);
  }
}

export function releaseRunnerExecutionWhenSettled(done, release, {
  onError = () => {},
} = {}) {
  if (typeof release !== 'function') {
    throw new TypeError('Runner execution release callback is required');
  }
  if (!done || typeof done.then !== 'function') {
    safeRelease(release, onError);
    return false;
  }

  void Promise.resolve(done)
    .then(
      () => safeRelease(release, onError),
      () => safeRelease(release, onError),
    )
    .catch(onError);
  return true;
}
