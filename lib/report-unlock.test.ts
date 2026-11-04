// Run with: npm test
//
// Two buyers (serials 205 and 211) paid $47 and were shown the paywall again
// when they opened their Action Plan. The report only unlocked on a Stripe
// session id in its URL, and Payment Link redirects are configured in the
// Stripe Dashboard - saved without {CHECKOUT_SESSION_ID}, they carry no id.
// These tests lock the rules that replaced that single point of failure.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  isDefinitiveStripeMiss,
  isPaidSessionForSerial,
  pickPaidSession,
  serialBelongsTo,
  isPaidCosmosUser,
  type CheckoutSessionLike,
} from "@/lib/server/report-unlock"
import { decideReportAccess } from "@/lib/client/purchase-proof"
import { returnOriginFrom } from "@/lib/client/funnel-origin"
import { FEEDBACK_MAX_CHARS, FEEDBACK_NOTE_MAX_CHARS } from "@/lib/feedback-limits"
import { submitToGoogleSheet } from "@/lib/submit-to-google-sheet"

const session = (
  payment_status: string,
  client_reference_id: string | null,
  tier?: string,
): CheckoutSessionLike => ({
  payment_status,
  client_reference_id,
  metadata: tier ? { tier } : {},
})

// ── Server: which Stripe session unlocks ──

test("a paid session for the buyer's email unlocks, with or without a serial", () => {
  const paid = session("paid", "205")
  assert.equal(pickPaidSession([paid], 205), paid)
  assert.equal(pickPaidSession([paid], undefined), paid, "a lost signup serial must not lock a buyer out")
  assert.equal(pickPaidSession([session("paid", null)], 205)?.payment_status, "paid")
})

test("the session carrying this browser's serial is preferred", () => {
  const other = session("paid", "180", "session")
  const mine = session("paid", "205", "diagnostic")
  assert.equal(pickPaidSession([other, mine], 205), mine)
})

test("an unpaid or missing session never unlocks", () => {
  assert.equal(pickPaidSession([session("unpaid", "205")], 205), null)
  assert.equal(pickPaidSession([], 205), null)
})

test("serial 205: paid with a work email, found by the serial on its row", () => {
  // Assessment email and checkout email differ; the row ties serial to email.
  const row = { email: "Buyer@Hotmail.com " }
  assert.equal(serialBelongsTo(row, "buyer@hotmail.com"), true, "case and whitespace insensitive")
  assert.equal(isPaidSessionForSerial(session("paid", "205"), 205), true)
})

test("a guessed serial unlocks nothing without its row's email", () => {
  assert.equal(serialBelongsTo({ email: "buyer@hotmail.com" }, "someone-else@example.com"), false)
  assert.equal(serialBelongsTo(null, "buyer@hotmail.com"), false, "no such serial")
  assert.equal(isPaidSessionForSerial(session("paid", "206"), 205), false, "another buyer's session")
  assert.equal(isPaidSessionForSerial(session("unpaid", "205"), 205), false)
})

test("only Stripe saying 'no such session' is a definitive miss", () => {
  assert.equal(isDefinitiveStripeMiss({ type: "StripeInvalidRequestError" }), true)
  // Everything else says nothing about the buyer, so it must not read as "not paid".
  for (const type of ["StripePermissionError", "StripeAuthenticationError", "StripeConnectionError", "StripeAPIError", "StripeRateLimitError"]) {
    assert.equal(isDefinitiveStripeMiss({ type }), false, type)
  }
  assert.equal(isDefinitiveStripeMiss(new Error("Missing STRIPE_SECRET_KEY")), false)
  assert.equal(isDefinitiveStripeMiss(null), false)
})

// ── Client: what the visitor sees ──

test("a buyer is never shown the paywall", () => {
  for (const unverifiable of [true, false]) {
    const seen = decideReportAccess({ paid: false, unverifiable, arrivedAsBuyer: true })
    assert.notEqual(seen, "denied", `arrived as buyer, unverifiable=${unverifiable}`)
  }
})

test("our outage unlocks a buyer; Stripe finding nothing asks them to confirm", () => {
  assert.equal(decideReportAccess({ paid: false, unverifiable: true, arrivedAsBuyer: true }), "allowed")
  assert.equal(decideReportAccess({ paid: false, unverifiable: false, arrivedAsBuyer: true }), "unconfirmed")
})

test("a confirmed payment unlocks; anyone else gets the paywall, outage or not", () => {
  assert.equal(decideReportAccess({ paid: true, unverifiable: false, arrivedAsBuyer: false }), "allowed")
  assert.equal(decideReportAccess({ paid: false, unverifiable: false, arrivedAsBuyer: false }), "denied")
  assert.equal(decideReportAccess({ paid: false, unverifiable: true, arrivedAsBuyer: false }), "denied")
})

test("the thank-you page links to the report as a buyer", async () => {
  const src = await readFile(new URL("../app/challenge/thank-you/page.tsx", import.meta.url), "utf8")
  assert.match(src, /\/challenge\/report\?[^`]*paid=1/, "the report link must carry paid=1")
  assert.match(src, /rememberPurchase\(/, "the thank-you page must remember the purchase")
})

// ── Cross-subdomain return ──

const apex = { origin: "https://aimerge.live", protocol: "https:" }

test("a buyer from a vertical subdomain is sent back to it", () => {
  assert.equal(returnOriginFrom("https://parents.aimerge.live", apex, "aimerge.live"), "https://parents.aimerge.live")
})

test("the return cookie can only ever point at a sibling origin", () => {
  assert.equal(returnOriginFrom("https://aimerge.live", apex, "aimerge.live"), null, "already there")
  assert.equal(returnOriginFrom("https://evil.example", apex, "aimerge.live"), null)
  assert.equal(returnOriginFrom("https://aimerge.live.evil.example", apex, "aimerge.live"), null)
  assert.equal(returnOriginFrom("https://evilaimerge.live", apex, "aimerge.live"), null)
  assert.equal(returnOriginFrom("http://parents.aimerge.live", apex, "aimerge.live"), null, "no protocol downgrade")
  assert.equal(returnOriginFrom("javascript:alert(1)", apex, "aimerge.live"), null)
  assert.equal(returnOriginFrom("not a url", apex, "aimerge.live"), null)
  assert.equal(returnOriginFrom(undefined, apex, "aimerge.live"), null)
})

// ── Beat feedback ──

test("the longest feedback a participant can type fits what the server stores", () => {
  const longestOption = "Not quite, but I am curious"
  assert.ok(FEEDBACK_MAX_CHARS >= longestOption.length + " | ".length + FEEDBACK_NOTE_MAX_CHARS)
})

test("feedback is clamped server-side, never rejected for length", async () => {
  const src = await readFile(new URL("../app/api/sheets/append/route.ts", import.meta.url), "utf8")
  assert.ok(!/feedback:\s*z\.string\(\)\.max\(200\)/.test(src), "the old 200-char rejection is gone")
  assert.match(src, /feedback:\s*z\.preprocess\([\s\S]{0,120}\.slice\(0, FEEDBACK_MAX_CHARS\)/)
})

test("a rate-limited write is retried, a malformed one is not", async () => {
  const realFetch = globalThis.fetch
  const payload = {
    action: "feedback" as const,
    firstName: "T",
    email: "t@example.com",
    serialNumber: 1,
    beatNumber: 3,
    feedback: "Yes - that is exactly it",
  }
  try {
    let calls = 0
    globalThis.fetch = (async () => new Response("{}", { status: ++calls === 1 ? 429 : 200 })) as typeof fetch
    assert.equal(await submitToGoogleSheet(payload), true)
    assert.equal(calls, 2, "429 retried")

    calls = 0
    globalThis.fetch = (async () => (++calls, new Response("{}", { status: 400 }))) as typeof fetch
    assert.equal(await submitToGoogleSheet(payload), false)
    assert.equal(calls, 1, "400 not retried")
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── Paywall bypass prevention (Issue #11) ──

test("shell.tsx does not allow client-side bypass via URL tier parameter", async () => {
  const src = await readFile(new URL("../app/challenge/report/shell.tsx", import.meta.url), "utf8")
  assert.ok(!src.includes('tier === "session" || tier === "transformation"'), "client tier bypass removed")
  assert.ok(!src.includes('searchParams.get("tier")'), "tier query parameter no longer read directly for access")
})

test("a paid tier in Cosmos DB unlocks for the matching email", () => {
  assert.equal(isPaidCosmosUser({ email: "buyer@example.com", paid_tier: "session" }, "buyer@example.com"), true)
  assert.equal(isPaidCosmosUser({ email: "buyer@example.com", paid_tier: "transformation" }, "BUYER@EXAMPLE.COM"), true, "case insensitive")
  assert.equal(isPaidCosmosUser({ email: " buyer@example.com ", paid_tier: "session" }, "buyer@example.com"), true, "whitespace trimmed")
  assert.equal(isPaidCosmosUser({ email: "buyer@example.com" }, "buyer@example.com"), false, "no paid_tier")
  assert.equal(isPaidCosmosUser({ email: "buyer@example.com", paid_tier: "" }, "buyer@example.com"), false, "empty paid_tier")
  assert.equal(isPaidCosmosUser({ email: "buyer@example.com", paid_tier: "session" }, "other@example.com"), false, "email mismatch")
  assert.equal(isPaidCosmosUser(null, "buyer@example.com"), false, "null row")
})

test("verify-session route checks Cosmos DB for paid tiers", async () => {
  const src = await readFile(new URL("../app/api/stripe/verify-session/route.ts", import.meta.url), "utf8")
  assert.match(src, /readUserIdentity\(serialNumber\)/, "checks serial in Cosmos DB")
  assert.match(src, /row\.paid_tier/, "unlocks if paid_tier is recorded on user row")
  assert.match(src, /readUserPurchaseByEmail\(email\)/, "checks email in Cosmos DB fallback")
})
