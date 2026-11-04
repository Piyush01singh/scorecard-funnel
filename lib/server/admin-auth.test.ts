import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ADMIN_SESSION_COOKIE,
  timingSafeMatch,
  createAdminSessionToken,
  verifyAdminSessionToken,
  parseCookie,
  buildAdminSessionCookie,
  buildAdminLogoutCookie,
  getAdminSession,
  isAdminAuthorized,
  isTechAuthorized,
  corsHeaders,
} from "./admin-auth.ts"

// Save original env
const origEnv = { ...process.env }

function resetEnv() {
  process.env.ADMIN_API_PASSWORD = "test-admin-password"
  process.env.TECHADMIN_API_PASSWORD = "test-tech-password"
  delete process.env.ADMIN_SESSION_SECRET
  delete process.env.ADMIN_ALLOWED_ORIGINS
}

test("timingSafeMatch: matches identical secrets", () => {
  assert.equal(timingSafeMatch("secret123", "secret123"), true)
  assert.equal(timingSafeMatch("secret123 ", " secret123 "), false) // provided whitespace is kept
  assert.equal(timingSafeMatch("secret123", " secret123 "), true) // expected is trimmed
})

test("timingSafeMatch: fails closed on mismatched or unset expected values", () => {
  assert.equal(timingSafeMatch("wrong", "secret123"), false)
  assert.equal(timingSafeMatch("secret12", "secret123"), false)
  assert.equal(timingSafeMatch("secret1234", "secret123"), false)
  assert.equal(timingSafeMatch("secret123", undefined), false)
  assert.equal(timingSafeMatch("secret123", ""), false)
  assert.equal(timingSafeMatch("", "secret123"), false)
})

test("parseCookie: extracts specific cookies correctly", () => {
  const header = "foo=bar; admin_session=my-token-123; session=other"
  assert.equal(parseCookie(header, "admin_session"), "my-token-123")
  assert.equal(parseCookie(header, "foo"), "bar")
  assert.equal(parseCookie(header, "session"), "other")
  assert.equal(parseCookie(header, "missing"), null)
  assert.equal(parseCookie(null, "admin_session"), null)
  assert.equal(parseCookie("", "admin_session"), null)

  // Substring safety: other_admin_session shouldn't match admin_session
  const subHeader = "other_admin_session=wrong; admin_session=correct"
  assert.equal(parseCookie(subHeader, "admin_session"), "correct")
})

test("token lifecycle: creates and verifies admin and tech tokens", () => {
  resetEnv()

  const adminToken = createAdminSessionToken("admin")
  assert.ok(adminToken, "Token should be created")
  const adminVerified = verifyAdminSessionToken(adminToken)
  assert.equal(adminVerified.ok, true)
  assert.equal(adminVerified.role, "admin")

  const techToken = createAdminSessionToken("tech")
  assert.ok(techToken, "Tech token should be created")
  const techVerified = verifyAdminSessionToken(techToken)
  assert.equal(techVerified.ok, true)
  assert.equal(techVerified.role, "tech")
})

test("token security: rejects tampered tokens", () => {
  resetEnv()

  const token = createAdminSessionToken("admin")!
  const [data, sig] = token.split(".")

  // Tamper with data (e.g. elevate role to tech)
  const decoded = JSON.parse(Buffer.from(data, "base64url").toString("utf8"))
  decoded.role = "tech"
  const tamperedData = Buffer.from(JSON.stringify(decoded)).toString("base64url")
  const tamperedToken = `${tamperedData}.${sig}`

  const result = verifyAdminSessionToken(tamperedToken)
  assert.equal(result.ok, false)

  // Tamper with signature
  const badSigToken = `${data}.${sig.slice(0, -2)}AA`
  assert.equal(verifyAdminSessionToken(badSigToken).ok, false)

  // Malformed structure
  assert.equal(verifyAdminSessionToken("bad-token").ok, false)
  assert.equal(verifyAdminSessionToken("a.b.c").ok, false)
  assert.equal(verifyAdminSessionToken("").ok, false)
})

test("token security: rejects expired tokens", () => {
  resetEnv()

  // Create an already-expired token (-10 seconds)
  const expiredToken = createAdminSessionToken("admin", -10)!
  const result = verifyAdminSessionToken(expiredToken)
  assert.equal(result.ok, false)
})

test("token security: fails closed when passwords and secrets are unset", () => {
  delete process.env.ADMIN_API_PASSWORD
  delete process.env.TECHADMIN_API_PASSWORD
  delete process.env.ADMIN_SESSION_SECRET

  const token = createAdminSessionToken("admin")
  assert.equal(token, null)
  assert.equal(verifyAdminSessionToken("dummy.token").ok, false)

  resetEnv()
})

test("buildAdminSessionCookie & buildAdminLogoutCookie format", () => {
  const cookie = buildAdminSessionCookie("token123", 3600)
  assert.ok(cookie.includes(`${ADMIN_SESSION_COOKIE}=token123`))
  assert.ok(cookie.includes("HttpOnly"))
  assert.ok(cookie.includes("SameSite=Lax"))
  assert.ok(cookie.includes("Path=/"))
  assert.ok(cookie.includes("Max-Age=3600"))

  const logoutCookie = buildAdminLogoutCookie()
  assert.ok(logoutCookie.includes(`${ADMIN_SESSION_COOKIE}=;`))
  assert.ok(logoutCookie.includes("Max-Age=0"))
  assert.ok(logoutCookie.includes("Expires=Thu, 01 Jan 1970"))
})

test("isAdminAuthorized: accepts valid admin session cookie", () => {
  resetEnv()
  const token = createAdminSessionToken("admin")!
  const req = new Request("http://localhost:3000/api/admin/prompts", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
  })

  assert.equal(isAdminAuthorized(req), true)
})

test("isAdminAuthorized: accepts valid tech session cookie (superset role)", () => {
  resetEnv()
  const token = createAdminSessionToken("tech")!
  const req = new Request("http://localhost:3000/api/admin/prompts", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
  })

  assert.equal(isAdminAuthorized(req), true)
})

test("isAdminAuthorized: backwards compatibility with X-Admin-Password header", () => {
  resetEnv()

  const reqAdmin = new Request("http://localhost:3000/api/admin/prompts", {
    headers: { "x-admin-password": "test-admin-password" },
  })
  assert.equal(isAdminAuthorized(reqAdmin), true)

  const reqTech = new Request("http://localhost:3000/api/admin/prompts", {
    headers: { "x-admin-password": "test-tech-password" },
  })
  assert.equal(isAdminAuthorized(reqTech), true)

  const reqBad = new Request("http://localhost:3000/api/admin/prompts", {
    headers: { "x-admin-password": "wrong" },
  })
  assert.equal(isAdminAuthorized(reqBad), false)

  const reqEmpty = new Request("http://localhost:3000/api/admin/prompts")
  assert.equal(isAdminAuthorized(reqEmpty), false)
})

test("isTechAuthorized: accepts only tech session cookie", () => {
  resetEnv()

  const techToken = createAdminSessionToken("tech")!
  const reqTech = new Request("http://localhost:3000/api/admin/stats", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${techToken}` },
  })
  assert.equal(isTechAuthorized(reqTech), true)

  const adminToken = createAdminSessionToken("admin")!
  const reqAdmin = new Request("http://localhost:3000/api/admin/stats", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${adminToken}` },
  })
  assert.equal(isTechAuthorized(reqAdmin), false, "Admin role cannot access tech console")
})

test("isTechAuthorized: backwards compatibility with X-Admin-Password header", () => {
  resetEnv()

  const reqTech = new Request("http://localhost:3000/api/admin/stats", {
    headers: { "x-admin-password": "test-tech-password" },
  })
  assert.equal(isTechAuthorized(reqTech), true)

  const reqAdmin = new Request("http://localhost:3000/api/admin/stats", {
    headers: { "x-admin-password": "test-admin-password" },
  })
  assert.equal(isTechAuthorized(reqAdmin), false, "Admin password cannot unlock tech routes")
})

test("corsHeaders: credentials enabled when origin is specified", () => {
  process.env.ADMIN_ALLOWED_ORIGINS = "https://admin.example.com"
  const req = new Request("http://localhost:3000/api/admin/stats", {
    headers: { origin: "https://admin.example.com" },
  })
  const headers = corsHeaders(req) as Record<string, string>
  assert.equal(headers["Access-Control-Allow-Origin"], "https://admin.example.com")
  assert.equal(headers["Access-Control-Allow-Credentials"], "true")
  assert.ok(headers["Access-Control-Allow-Methods"].includes("DELETE"))

  // Reset env
  Object.keys(process.env).forEach((k) => delete process.env[k])
  Object.assign(process.env, origEnv)
})
