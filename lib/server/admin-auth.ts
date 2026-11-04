/**
 * CORS headers and server-side auth for admin API routes.
 * Used by the standalone admin.html to call the API from a different origin.
 */

import { timingSafeEqual, createHmac, createHash } from "node:crypto"

const isProd = process.env.NODE_ENV === "production"

function sameOrigin(request: Request, origin: string): boolean {
  if (!origin) return false
  try {
    const reqUrl = new URL(request.url)
    const originUrl = new URL(origin)
    return reqUrl.host === originUrl.host && reqUrl.protocol === originUrl.protocol
  } catch {
    return false
  }
}

/** Returns CORS headers based on the request origin and ADMIN_ALLOWED_ORIGINS env var. */
export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin") ?? ""
  const allowed = (process.env.ADMIN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  // Determine if this origin is allowed — FAIL CLOSED.
  let allowOrigin = ""
  if (allowed.includes(origin)) {
    allowOrigin = origin
  } else if (origin === "null" && allowed.includes("null")) {
    // file:// sends Origin: null
    allowOrigin = "null"
  } else if (allowed.length === 0) {
    // No whitelist configured. Allow only same-origin in production; any origin in dev.
    if (!isProd) {
      allowOrigin = origin || "*"
    } else if (sameOrigin(request, origin)) {
      allowOrigin = origin
    }
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    "Access-Control-Max-Age": "86400",
  }

  if (allowOrigin && allowOrigin !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true"
  }

  return headers
}

/** Constant-time compare of a provided secret against an expected env value.
 *  Returns false when the expected value is unset (fail closed). */
export function timingSafeMatch(provided: string, expected: string | undefined): boolean {
  const exp = expected?.trim()
  if (!exp || !provided) return false

  const a = Buffer.from(provided, "utf8")
  const b = Buffer.from(exp, "utf8")
  // timingSafeEqual requires equal-length buffers. Compare lengths too — both
  // checks combined stay constant-time w.r.t. the actual secret contents.
  if (a.length !== b.length) {
    try {
      timingSafeEqual(b, b) // dummy compare to normalize timing
    } catch {
      /* noop */
    }
    return false
  }
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export const ADMIN_SESSION_COOKIE = "admin_session"

export type AdminRole = "admin" | "tech"

export interface AdminSessionPayload {
  role: AdminRole
  iat: number
  exp: number
}

/** Extracts a cookie value by name from the Cookie header string. */
export function parseCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/** Derives a stable HMAC signing key for sessions. */
function getSessionSigningKey(): Buffer | null {
  const customSecret = process.env.ADMIN_SESSION_SECRET?.trim()
  if (customSecret) {
    return Buffer.from(customSecret, "utf8")
  }
  const adminPw = process.env.ADMIN_API_PASSWORD?.trim() ?? ""
  const techPw = process.env.TECHADMIN_API_PASSWORD?.trim() ?? ""
  if (!adminPw && !techPw) {
    return null
  }
  return createHash("sha256").update(`admin-session-v1:${adminPw}:${techPw}`).digest()
}

/** Creates a signed, tamper-proof session token. */
export function createAdminSessionToken(
  role: AdminRole,
  expiresInSeconds = 60 * 60 * 24 * 7 // 7 days
): string | null {
  const key = getSessionSigningKey()
  if (!key) return null

  const now = Math.floor(Date.now() / 1000)
  const payload: AdminSessionPayload = {
    role,
    iat: now,
    exp: now + expiresInSeconds,
  }

  const data = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = createHmac("sha256", key).update(data).digest("base64url")
  return `${data}.${signature}`
}

/** Verifies a signed session token. */
export function verifyAdminSessionToken(
  token: string | null | undefined
): { ok: boolean; role?: AdminRole } {
  if (!token || typeof token !== "string") return { ok: false }
  const parts = token.split(".")
  if (parts.length !== 2) return { ok: false }
  const [data, signature] = parts
  if (!data || !signature) return { ok: false }

  const key = getSessionSigningKey()
  if (!key) return { ok: false }

  const expectedSignature = createHmac("sha256", key).update(data).digest("base64url")
  const sigBuf = Buffer.from(signature, "utf8")
  const expBuf = Buffer.from(expectedSignature, "utf8")

  if (sigBuf.length !== expBuf.length) {
    try {
      timingSafeEqual(expBuf, expBuf)
    } catch {
      /* noop */
    }
    return { ok: false }
  }
  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false }
  }

  try {
    const raw = Buffer.from(data, "base64url").toString("utf8")
    const payload = JSON.parse(raw) as Partial<AdminSessionPayload>
    const now = Math.floor(Date.now() / 1000)

    if (typeof payload.exp !== "number" || payload.exp < now) {
      return { ok: false }
    }
    if (payload.role !== "admin" && payload.role !== "tech") {
      return { ok: false }
    }

    return { ok: true, role: payload.role }
  } catch {
    return { ok: false }
  }
}

/** Builds the Set-Cookie header string for an admin session. */
export function buildAdminSessionCookie(
  token: string,
  maxAgeSeconds = 60 * 60 * 24 * 7
): string {
  const secure = isProd ? "; Secure" : ""
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
}

/** Builds the Set-Cookie header string to clear the admin session cookie. */
export function buildAdminLogoutCookie(): string {
  const secure = isProd ? "; Secure" : ""
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`
}

/**
 * Extracts and verifies the admin session from request cookies.
 */
export function getAdminSession(request: Request): { role: AdminRole } | null {
  const cookieHeader = request.headers.get("cookie")
  const token = parseCookie(cookieHeader, ADMIN_SESSION_COOKIE)
  if (!token) return null
  const res = verifyAdminSessionToken(token)
  if (!res.ok || !res.role) return null
  return { role: res.role }
}

/**
 * Admin access. Accepts EITHER a valid admin session cookie OR (for backward
 * compatibility) the standard admin password / tech-admin password in the
 * X-Admin-Password header.
 * Tech is an elevated, superset role, so the tech credential or tech session can
 * use every admin route (prompts, responses) the shared console calls. Uses a
 * constant-time comparison to prevent timing attacks.
 */
export function isAdminAuthorized(request: Request): boolean {
  const session = getAdminSession(request)
  if (session && (session.role === "admin" || session.role === "tech")) {
    return true
  }

  const provided = request.headers.get("x-admin-password")?.trim() ?? ""
  if (!provided) return false
  return (
    timingSafeMatch(provided, process.env.ADMIN_API_PASSWORD) ||
    timingSafeMatch(provided, process.env.TECHADMIN_API_PASSWORD)
  )
}

/**
 * Tech-admin access. Accepts ONLY a valid tech session cookie OR (for backward
 * compatibility) the dedicated TECHADMIN_API_PASSWORD in the X-Admin-Password
 * header. Gates the /techadmin-exclusive surfaces (analytics, telemetry).
 * The regular admin password does NOT pass here, which is what keeps the two consoles separate.
 */
export function isTechAuthorized(request: Request): boolean {
  const session = getAdminSession(request)
  if (session && session.role === "tech") {
    return true
  }

  const provided = request.headers.get("x-admin-password")?.trim() ?? ""
  if (!provided) return false
  return timingSafeMatch(provided, process.env.TECHADMIN_API_PASSWORD)
}

/**
 * Preview-secret check for the report preview bypass. Unlike the request-based
 * helpers above, this takes the raw secret string (the report preview flow
 * sends it in a JSON body, not the x-admin-password header). Accepts either the
 * admin OR tech password, constant-time. Lets us review the paid report layout
 * without completing a payment; a regular customer can't unlock it because they
 * don't hold the secret and the check runs server-side.
 */
export function isPreviewSecret(secret: string | undefined | null): boolean {
  const provided = secret?.trim() ?? ""
  if (!provided) return false
  return (
    timingSafeMatch(provided, process.env.ADMIN_API_PASSWORD) ||
    timingSafeMatch(provided, process.env.TECHADMIN_API_PASSWORD)
  )
}
