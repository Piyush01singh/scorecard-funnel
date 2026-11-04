/**
 * Resolves the trusted site origin for Stripe checkout callbacks (success_url / cancel_url).
 *
 * CWE-601 Fix: Never trust unvalidated client headers (such as `x-forwarded-host` or `host`),
 * which allow an attacker to inject an arbitrary redirect domain and capture the sensitive
 * Stripe checkout session_id.
 *
 * Redirection origins are strictly anchored to:
 * 1. process.env.NEXT_PUBLIC_SITE_URL or process.env.SITE_URL if configured.
 * 2. An allowed origin from ALLOWED_CHECKOUT_ORIGINS (comma-separated whitelist), if matching.
 * 3. In local development / testing without a configured site URL, localhost / 127.0.0.1 origins from req.url.
 * 4. Fallback to canonical production origin (https://aimerge.live).
 */
export function getCheckoutRedirectBaseUrl(req?: Request): string {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.SITE_URL?.trim()

  if (configured) {
    try {
      const url = new URL(configured.includes("://") ? configured : `https://${configured}`)
      return url.origin
    } catch {
      return configured.replace(/\/+$/, "")
    }
  }

  const allowedOrigins = process.env.ALLOWED_CHECKOUT_ORIGINS
    ?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  if (allowedOrigins && allowedOrigins.length > 0 && req) {
    try {
      const reqOrigin = new URL(req.url).origin.toLowerCase()
      if (allowedOrigins.includes(reqOrigin)) {
        return reqOrigin
      }
    } catch {
      // ignore
    }
  }

  if (req) {
    try {
      const url = new URL(req.url)
      if (
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname.endsWith(".localhost")
      ) {
        return url.origin
      }
    } catch {
      // ignore
    }
  }

  return "https://aimerge.live"
}
