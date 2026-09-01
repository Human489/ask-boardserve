/**
 * Constant-time string comparison.
 *
 * Returns early on a length mismatch, so this leaks the length of the expected
 * value but not its contents. Acceptable here: the passcode's length is not the
 * secret, and the alternative (hashing both sides first) is more code for a
 * threat this deployment does not face.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
