/**
 * Values a journey holds that must never reach a result, a log, a summary or
 * an alert: the test user's password and a port's key. A journey hands each
 * one to `keepSecret` as soon as it holds it, and every step's detail goes
 * through `redact` before it is recorded (`Run.step` in `report.ts`).
 *
 * This is the second line of defence. The first is that no detail is built
 * from a secret: details are written by hand, and a browser error is reduced
 * to its first line, which carries no call log and no element text.
 */
const held = new Set<string>()

/** Remembers `value` as a secret and returns it. */
export function keepSecret(value: string): string {
  // A one-letter "secret" would redact half of every message.
  if (value.length >= 4) held.add(value)
  return value
}

/** `text` with every secret, as written, URL-encoded or JSON-escaped, replaced by `[redacted]`. */
export function redact(text: string): string {
  let out = text
  for (const secret of held) {
    for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      out = out.replaceAll(form, '[redacted]')
    }
  }
  return out
}

/** Forgets every secret, for tests. */
export function forgetSecrets(): void {
  held.clear()
}
