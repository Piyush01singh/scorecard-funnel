/**
 * Pure decision helpers for /api/stripe/verify-session. Kept free of the
 * Stripe SDK (structural types only) so the rules are unit-testable.
 */

/** The fields of a Stripe Checkout Session the unlock reads. */
export interface CheckoutSessionLike {
  payment_status: string
  client_reference_id: string | null
  metadata?: Record<string, string> | null
}

/**
 * The paid session that unlocks the report for this buyer, or null.
 *
 * The caller has already filtered to the buyer's email. When the browser still
 * knows its funnel serial, a session carrying that serial (the offer page sets
 * it as client_reference_id) is preferred, but a paid session for the email is
 * enough on its own: the signup serial can be lost (see submitSignup), and the
 * report only ever renders the viewer's own locally stored assessment, so an
 * email match unlocks nothing that belongs to anyone else.
 */
export function pickPaidSession<T extends CheckoutSessionLike>(
  sessions: T[],
  serialNumber?: number | null,
): T | null {
  const paid = sessions.filter((s) => s.payment_status === "paid")
  if (paid.length === 0) return null
  if (serialNumber != null) {
    const same = paid.find((s) => s.client_reference_id === String(serialNumber))
    if (same) return same
  }
  return paid[0]
}

/**
 * Whether a claimed serial may be looked up on the buyer's behalf: only when
 * the funnel row for that serial belongs to the email the visitor also claims.
 * Serials are small sequential numbers and trivially guessed, so a serial on
 * its own proves nothing; tied to the row's email it is as strong as the email
 * lookup, and it catches the buyer who typed a different email at checkout.
 */
export function serialBelongsTo(
  row: { email: string } | null,
  claimedEmail: string,
): boolean {
  if (!row?.email) return false
  return row.email.trim().toLowerCase() === claimedEmail.trim().toLowerCase()
}

/** Whether this is a paid session the offer page tagged with this serial
 *  (it sets the serial as client_reference_id on the Payment Link). */
export function isPaidSessionForSerial(
  session: CheckoutSessionLike,
  serialNumber: number,
): boolean {
  return session.payment_status === "paid" && session.client_reference_id === String(serialNumber)
}

/**
 * True when a Stripe error is Stripe answering "no" (an unknown or malformed
 * session id, a test-mode id against a live key) rather than Stripe being
 * unreachable or our key being unable to ask. Only the latter may be treated
 * as "could not verify"; a forged `cs_live_…` id must stay a plain denial.
 */
export function isDefinitiveStripeMiss(e: unknown): boolean {
  return (e as { type?: unknown } | null)?.type === "StripeInvalidRequestError"
}

/**
 * True when the Cosmos DB row belongs to the claimed email and records a paid tier.
 */
export function isPaidCosmosUser(
  row: { email: string; paid_tier?: string } | null,
  claimedEmail: string,
): boolean {
  if (!row?.email || !row?.paid_tier) return false
  return row.email.trim().toLowerCase() === claimedEmail.trim().toLowerCase()
}
