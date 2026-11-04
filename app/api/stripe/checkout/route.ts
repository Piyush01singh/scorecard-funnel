import { NextResponse } from "next/server"
import { z } from "zod"
import { getStripe, getCheckoutRedirectBaseUrl } from "@/lib/stripe"

// Only "diagnostic" hits Stripe here; session/transformation are
// paid + booked inside Calendly's hosted flow, which uses its own
// Stripe integration and skips this endpoint entirely.
//
// Diagnostic price/product are resolved from env at request time
// (not module load) so a misconfigured deploy fails per-request
// with a clear 500 rather than crashing the whole route handler
// import. Required env vars:
//   STRIPE_DIAGNOSTIC_PRICE_ID         (preferred — exact Price ID)
//   or
//   STRIPE_DIAGNOSTIC_PRODUCT_ID       + STRIPE_DIAGNOSTIC_PRICE_CENTS
function getDiagnosticConfig(): {
  priceId?: string
  productId?: string
  unitAmount?: number
} {
  const priceId = process.env.STRIPE_DIAGNOSTIC_PRICE_ID?.trim()
  if (priceId) return { priceId }

  const productId = process.env.STRIPE_DIAGNOSTIC_PRODUCT_ID?.trim()
  const unitAmountStr = process.env.STRIPE_DIAGNOSTIC_PRICE_CENTS?.trim()
  if (!productId) {
    throw new Error(
      "Stripe diagnostic config missing: set STRIPE_DIAGNOSTIC_PRICE_ID, or STRIPE_DIAGNOSTIC_PRODUCT_ID + STRIPE_DIAGNOSTIC_PRICE_CENTS",
    )
  }
  if (!unitAmountStr) {
    throw new Error(
      "STRIPE_DIAGNOSTIC_PRICE_CENTS is required when using STRIPE_DIAGNOSTIC_PRODUCT_ID",
    )
  }
  const unitAmount = Number.parseInt(unitAmountStr, 10)
  if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
    throw new Error(
      "STRIPE_DIAGNOSTIC_PRICE_CENTS must be a positive integer (cents)",
    )
  }
  return { productId, unitAmount }
}

const Body = z.object({
  email: z.string().trim().email().max(254),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  audience: z.enum(["individual", "team"]).optional(),
  tier: z.enum(["diagnostic"]).default("diagnostic"),
  // Forwarded into Stripe metadata so the webhook can record the purchase
  // against the exact user row (for /techadmin analytics).
  serialNumber: z.number().int().positive().optional(),
})

export async function POST(req: Request) {
  let json: unknown
  try {
    json = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { email, firstName, lastName, audience, tier, serialNumber } = parsed.data

  let diagnosticConfig: ReturnType<typeof getDiagnosticConfig>
  try {
    diagnosticConfig = getDiagnosticConfig()
  } catch (err) {
    console.error("[stripe/checkout] env misconfiguration:", err)
    return NextResponse.json(
      { error: "Checkout is not configured. Please contact support." },
      { status: 500 },
    )
  }

  // Anchor redirects strictly to the trusted site origin.
  // Never trust x-forwarded-host or host headers (CWE-601 open redirect / host injection).
  const siteUrl = getCheckoutRedirectBaseUrl(req)

  // {CHECKOUT_SESSION_ID} is a Stripe-side template token — must
  // arrive unencoded, so we assemble the query string manually
  // rather than via URLSearchParams (which percent-encodes braces).
  const successQuery = [
    "paid=1",
    `tier=${tier}`,
    audience ? `audience=${encodeURIComponent(audience)}` : null,
    "session_id={CHECKOUT_SESSION_ID}",
  ]
    .filter(Boolean)
    .join("&")
  const successUrl = `${siteUrl}/challenge/thank-you?${successQuery}`
  const cancelUrl = audience
    ? `${siteUrl}/challenge/${audience}/offer?canceled=1`
    : `${siteUrl}/?canceled=1`

  try {
    const stripe = getStripe()
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim()

    // Prefer a Stripe Price ID when configured (cleanest — lets
    // the team change pricing entirely from the Dashboard). Fall
    // back to inline price_data bound to a product when only the
    // product ID + amount are provided.
    const lineItem = diagnosticConfig.priceId
      ? ({ quantity: 1, price: diagnosticConfig.priceId } as const)
      : ({
          quantity: 1,
          price_data: {
            currency: "usd" as const,
            unit_amount: diagnosticConfig.unitAmount!,
            product: diagnosticConfig.productId!,
          },
        } as const)

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [lineItem],
      customer_email: email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        source: "scorecard-funnel",
        tier,
        productId: diagnosticConfig.productId ?? "",
        priceId: diagnosticConfig.priceId ?? "",
        audience: audience ?? "",
        firstName,
        lastName: lastName ?? "",
        fullName,
        serialNumber: serialNumber ? String(serialNumber) : "",
      },
      payment_intent_data: {
        metadata: {
          source: "scorecard-funnel",
          tier,
          audience: audience ?? "",
          firstName,
          lastName: lastName ?? "",
        },
      },
    })

    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe did not return a checkout URL" },
        { status: 502 },
      )
    }

    return NextResponse.json({
      checkoutUrl: session.url,
      sessionId: session.id,
    })
  } catch (err) {
    console.error("[stripe/checkout] failed:", err)
    return NextResponse.json(
      {
        error: "Could not create checkout session",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }
}
