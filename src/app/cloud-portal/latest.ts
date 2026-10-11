/**
 * Lets only the most recent of overlapping loads apply its result: each call starts a load and
 * returns a check that stays true until a newer load starts.
 */
export function latestRequest(): () => () => boolean {
  let current = 0
  return () => {
    const started = ++current
    return () => started === current
  }
}
