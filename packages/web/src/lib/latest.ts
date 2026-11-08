/**
 * Keeps only the newest of overlapping loads. Each call returns a check that stays true until the
 * next call: an answer (or failure) that arrives after a newer request was sent is dropped, instead
 * of replacing what the newer one shows (another folder's queries, filter's list, connection's
 * references).
 */
export function latestOnly(): () => () => boolean {
  let generation = 0;
  return () => {
    const mine = ++generation;
    return () => mine === generation;
  };
}
