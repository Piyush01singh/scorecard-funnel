import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { getCheckoutRedirectBaseUrl } from "@/lib/checkout-url"

test("uses configured NEXT_PUBLIC_SITE_URL and normalizes trailing slash", () => {
  const prevPublic = process.env.NEXT_PUBLIC_SITE_URL
  const prevSite = process.env.SITE_URL
  try {
    process.env.NEXT_PUBLIC_SITE_URL = "https://aimerge.live/"
    delete process.env.SITE_URL

    const origin = getCheckoutRedirectBaseUrl()
    assert.equal(origin, "https://aimerge.live")
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prevPublic
    process.env.SITE_URL = prevSite
  }
})

test("prepends https protocol if NEXT_PUBLIC_SITE_URL is provided without scheme", () => {
  const prevPublic = process.env.NEXT_PUBLIC_SITE_URL
  try {
    process.env.NEXT_PUBLIC_SITE_URL = "aimerge.live"
    const origin = getCheckoutRedirectBaseUrl()
    assert.equal(origin, "https://aimerge.live")
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prevPublic
  }
})

test("falls back to SITE_URL if NEXT_PUBLIC_SITE_URL is missing", () => {
  const prevPublic = process.env.NEXT_PUBLIC_SITE_URL
  const prevSite = process.env.SITE_URL
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL
    process.env.SITE_URL = "https://example.org"

    const origin = getCheckoutRedirectBaseUrl()
    assert.equal(origin, "https://example.org")
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prevPublic
    process.env.SITE_URL = prevSite
  }
})

test("CWE-601 defense: untrusted x-forwarded-host and host headers are completely ignored", () => {
  const prevPublic = process.env.NEXT_PUBLIC_SITE_URL
  try {
    process.env.NEXT_PUBLIC_SITE_URL = "https://aimerge.live"

    // Simulate an attacker-controlled request with injected headers
    const maliciousReq = new Request("https://aimerge.live/api/stripe/checkout", {
      method: "POST",
      headers: {
        "x-forwarded-host": "attacker.evil.com",
        "x-forwarded-proto": "https",
        host: "attacker.evil.com",
      },
    })

    const origin = getCheckoutRedirectBaseUrl(maliciousReq)
    assert.equal(origin, "https://aimerge.live")
    assert.notEqual(origin, "https://attacker.evil.com")
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prevPublic
  }
})

test("local development fallback permits localhost and 127.0.0.1 when env var is unset", () => {
  const prevPublic = process.env.NEXT_PUBLIC_SITE_URL
  const prevSite = process.env.SITE_URL
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.SITE_URL

    const localReq1 = new Request("http://localhost:3000/api/stripe/checkout", { method: "POST" })
    assert.equal(getCheckoutRedirectBaseUrl(localReq1), "http://localhost:3000")

    const localReq2 = new Request("http://127.0.0.1:8080/api/stripe/checkout", { method: "POST" })
    assert.equal(getCheckoutRedirectBaseUrl(localReq2), "http://127.0.0.1:8080")
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prevPublic
    process.env.SITE_URL = prevSite
  }
})

test("untrusted request hostname without env var falls back to default trusted production origin", () => {
  const prevPublic = process.env.NEXT_PUBLIC_SITE_URL
  const prevSite = process.env.SITE_URL
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.SITE_URL

    const evilReq = new Request("https://evil.attacker.com/api/stripe/checkout", { method: "POST" })
    assert.equal(getCheckoutRedirectBaseUrl(evilReq), "https://aimerge.live")
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prevPublic
    process.env.SITE_URL = prevSite
  }
})

test("ALLOWED_CHECKOUT_ORIGINS whitelist is respected if configured", () => {
  const prevPublic = process.env.NEXT_PUBLIC_SITE_URL
  const prevSite = process.env.SITE_URL
  const prevAllowed = process.env.ALLOWED_CHECKOUT_ORIGINS
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.SITE_URL
    process.env.ALLOWED_CHECKOUT_ORIGINS = "https://staging.aimerge.live,https://preview.aimerge.live"

    const stagingReq = new Request("https://staging.aimerge.live/api/stripe/checkout", { method: "POST" })
    assert.equal(getCheckoutRedirectBaseUrl(stagingReq), "https://staging.aimerge.live")

    const unlistedReq = new Request("https://unlisted.evil.com/api/stripe/checkout", { method: "POST" })
    assert.equal(getCheckoutRedirectBaseUrl(unlistedReq), "https://aimerge.live")
  } finally {
    process.env.NEXT_PUBLIC_SITE_URL = prevPublic
    process.env.SITE_URL = prevSite
    process.env.ALLOWED_CHECKOUT_ORIGINS = prevAllowed
  }
})

test("app/api/stripe/checkout/route.ts does not rely on x-forwarded-host or unvalidated host header", async () => {
  const routeContent = await readFile(
    new URL("../app/api/stripe/checkout/route.ts", import.meta.url),
    "utf8",
  )
  assert.ok(
    !routeContent.includes('req.headers.get("x-forwarded-host")'),
    "must not use x-forwarded-host header",
  )
  assert.ok(
    !routeContent.includes("forwardedHost"),
    "must not reference forwardedHost",
  )
})
