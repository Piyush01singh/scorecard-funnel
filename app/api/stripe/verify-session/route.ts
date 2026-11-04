import { NextResponse } from "next/server"
import { z } from "zod"
import { getStripe } from "@/lib/stripe"
import { redactError } from "@/lib/security"
import { isPreviewSecret } from "@/lib/server/admin-auth"
import { isCosmosConfigured, readUserIdentity, readUserPurchaseByEmail } from "@/lib/server/cosmos-db"
import {
  isDefinitiveStripeMiss,
  isPaidSessionForSerial,
  pickPaidSession,
  serialBelongsTo,
} from "@/lib/server/report-unlock"

// Most completed sessions the serial lookup will read before giving up.
const SERIAL_SCAN_CAP = 500

/**
 * POST /api/stripe/verify-session
 *
 * Server-side proof of payment for the $47 Diagnostic report. The report page
 * used to unlock on a bare `?paid=1` query param — trivially forgeable, which
 * let anyone who finished the (free) assessment download the paid report. This
 * route instead asks Stripe itself whether the buyer paid, so the unlock can't
 * be faked from the client.
 *
 * Three ways to prove it, tried in order:
 *
 *  1. `sessionId` - the Checkout Session id from the success redirect.
 *  2. `email` - a paid Checkout Session for the buyer's email. This matters in
 *     practice: every tier is sold through Stripe Payment Links, whose success
 *     redirect is configured in the Stripe Dashboard, and as of Sep 2026 none
 *     of the six live links included the `{CHECKOUT_SESSION_ID}` placeholder,
 *     so no buyer ever arrived with an id. Two buyers (serials 205 and 211)
 *     paid, reached the report, and were shown the paywall again.
 *  3. `serialNumber` + `email` - the paid session tagged with the funnel
 *     serial (client_reference_id), for a buyer who typed a different email
 *     at checkout. Only after the serial's row is shown to be the claimed
 *     email's, because serials are guessable.
 *
 * Returns { ok, paid, tier, unverifiable }. `paid` is only true when Stripe
 * itself reports a paid session. `unverifiable` means Stripe could not be
 * asked at all (outage, missing/restricted key) - distinct from a definitive
 * "no payment", so the report page can avoid telling a buyer to pay again
 * because OUR side is broken.
 *
 * Note: the $497 / $1,997 / $4,997 tiers are paid inside Calendly's hosted flow and have
 * no Stripe session here — their purchases are recorded server-side in Cosmos DB
 * (via the Calendly webhook / thank-you page) and verified against Cosmos DB below.
 *
 * Preview bypass: a `previewSecret` matching the admin/tech password unlocks
 * (paid:true, tier:"preview") WITHOUT a Stripe call, so we can review the paid
 * report layout without paying. The check is server-side and constant-time —
 * a regular customer can't forge it because they don't hold the secret.
 */

const Body = z.object({
  sessionId: z.string().trim().min(1).max(120).optional(),
  previewSecret: z.string().trim().min(1).max(200).optional(),
  // Lenient on purpose: these come from the visitor's stored funnel state, and
  // a malformed one must not reject the request and take a valid sessionId
  // down with it. Anything unusable is simply treated as absent.
  email: z.string().trim().toLowerCase().email().max(254).optional().catch(undefined),
  serialNumber: z.number().int().positive().optional().catch(undefined),
})

// Stripe Checkout Session ids are `cs_test_…` / `cs_live_…`. Reject anything
// else before spending a Stripe API call (and to avoid leaking lookups).
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]+$/

export async function POST(req: Request) {
  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ ok: false, paid: false, error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, paid: false, error: "Invalid input" }, { status: 400 })
  }
  const { sessionId, previewSecret, email, serialNumber } = parsed.data

  // Preview bypass (review-only): a valid admin/tech secret unlocks the report
  // layout without a Stripe session. Checked first, server-side, constant-time.
  if (isPreviewSecret(previewSecret)) {
    return NextResponse.json({ ok: true, paid: true, tier: "preview" })
  }

  // Set when a Stripe call failed for a reason that says nothing about the
  // buyer (network, auth, permissions, rate limit) - as opposed to Stripe
  // answering "no such session" or "not paid".
  let unverifiable = false

  if (sessionId && SESSION_ID_RE.test(sessionId)) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(sessionId)
      if (session.payment_status === "paid") {
        return NextResponse.json({
          ok: true,
          paid: true,
          tier: typeof session.metadata?.tier === "string" ? session.metadata.tier : null,
        })
      }
    } catch (e) {
      if (!isDefinitiveStripeMiss(e)) unverifiable = true
      console.error("[stripe/verify-session] retrieve", redactError(e))
    }
  }

  if (email) {
    try {
      const { data } = await getStripe().checkout.sessions.list({
        customer_details: { email },
        status: "complete",
        limit: 100,
      })
      const match = pickPaidSession(data, serialNumber)
      if (match) {
        return NextResponse.json({
          ok: true,
          paid: true,
          tier: typeof match.metadata?.tier === "string" ? match.metadata.tier : null,
        })
      }
    } catch (e) {
      if (!isDefinitiveStripeMiss(e)) unverifiable = true
      console.error("[stripe/verify-session] list by email", redactError(e))
    }
  }

  // The buyer may have typed a different email at checkout (serial 205 did:
  // a work address at Stripe, a personal one in the assessment), so the email
  // lookup finds nothing. The offer page tags every checkout with the funnel
  // serial, so look for that instead - but only once the serial's own row is
  // shown to belong to the claimed email, since serials are guessable.
  if (email && serialNumber && isCosmosConfigured()) {
    try {
      const row = await readUserIdentity(serialNumber)
      if (serialBelongsTo(row, email)) {
        if (row.paid_tier) {
          return NextResponse.json({
            ok: true,
            paid: true,
            tier: row.paid_tier,
          })
        }
        // The purchase cannot predate the signup. The hour of slack covers
        // clock skew; the cap bounds the scan on a busy account.
        const signupMs = Date.parse(row!.createdAt)
        const since = Number.isFinite(signupMs) ? Math.floor(signupMs / 1000) - 3600 : undefined
        let scanned = 0
        for await (const s of getStripe().checkout.sessions.list({
          status: "complete",
          limit: 100,
          ...(since ? { created: { gte: since } } : {}),
        })) {
          if (isPaidSessionForSerial(s, serialNumber)) {
            return NextResponse.json({
              ok: true,
              paid: true,
              tier: typeof s.metadata?.tier === "string" ? s.metadata.tier : null,
            })
          }
          if (++scanned >= SERIAL_SCAN_CAP) break
        }
      }
    } catch (e) {
      if (!isDefinitiveStripeMiss(e)) unverifiable = true
      console.error("[stripe/verify-session] lookup by serial", redactError(e))
    }
  }

  // Deeper tiers ($497 / $1,997 / $4,997) booked and paid via Calendly are recorded
  // in Cosmos DB (via the Calendly webhook or thank-you page). If Stripe found nothing,
  // check Cosmos DB by email for a recorded purchase.
  if (email && isCosmosConfigured()) {
    try {
      const purchase = await readUserPurchaseByEmail(email)
      if (purchase?.paid_tier) {
        return NextResponse.json({
          ok: true,
          paid: true,
          tier: purchase.paid_tier,
        })
      }
    } catch (e) {
      console.error("[stripe/verify-session] lookup by email in cosmos", redactError(e))
    }
  }

  if (unverifiable) {
    // Loud on purpose: while this persists, buyers are unlocked on their
    // thank-you-page arrival alone (see app/challenge/report/shell.tsx).
    console.error(
      "[stripe/verify-session] Stripe unreachable or key lacks Checkout Sessions read access - payment could not be verified",
    )
  }
  return NextResponse.json({ ok: true, paid: false, unverifiable })
}
