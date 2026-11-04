"use client"

import dynamic from "next/dynamic"
import { Suspense, useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import posthog from "posthog-js"
import { ReportPaywall } from "@/components/challenge/report-paywall"
import { useChallenge } from "@/context/challenge-context"
import {
  decideReportAccess,
  recallPurchase,
  type ReportAccess,
} from "@/lib/client/purchase-proof"

// jspdf's "node" entrypoint pulls fflate's Worker dynamic-import path, which
// Turbopack cannot resolve during the SSR pass. Loading ClarityReport with
// ssr:false skips that pass entirely - the report is a print/download tool
// and only ever needs to run in the browser anyway.
const ClarityReport = dynamic(
  () =>
    import("@/components/challenge/clarity-report").then((m) => ({
      default: m.ClarityReport,
    })),
  { ssr: false }
)

type Access = "checking" | ReportAccess

const SUPPORT_EMAIL = "sales@tetranoodle.com"

// Retries for a verification that could not reach an answer (network error,
// rate limit, Stripe unreachable). A definitive answer is never retried.
const VERIFY_BACKOFF_MS = [800, 2000]

async function verifyPurchase(body: {
  sessionId?: string
  email?: string
  serialNumber?: number
}): Promise<{ paid: boolean; unverifiable: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch("/api/stripe/verify-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const d: { paid?: boolean; unverifiable?: boolean } = await r
        .json()
        .catch(() => ({}))
      if (d?.paid) return { paid: true, unverifiable: false }
      if (r.ok && !d?.unverifiable) return { paid: false, unverifiable: false }
      const transient = !r.ok && (r.status >= 500 || r.status === 408 || r.status === 429)
      if (!r.ok && !transient) return { paid: false, unverifiable: false }
    } catch {
      /* network error - retry below */
    }
    if (attempt >= VERIFY_BACKOFF_MS.length) return { paid: false, unverifiable: true }
    await new Promise((res) => setTimeout(res, VERIFY_BACKOFF_MS[attempt]))
  }
}

/**
 * Gate for the paid report. The report is a paid deliverable (every tier from
 * $47 up). Access is decided as follows:
 *
 *  - Stripe ($47 Diagnostic): verified SERVER-SIDE (/api/stripe/verify-session)
 *    - a forged `?paid=1` unlocks nothing by itself. The proof is the Checkout
 *    Session id when we have one (success redirect, or remembered by the
 *    thank-you page), and otherwise a paid session for the buyer's email.
 *    The email fallback exists because Payment Link redirects are configured
 *    in the Stripe Dashboard and a redirect without `{CHECKOUT_SESSION_ID}`
 *    arrives with no id: buyers who had paid were shown the paywall again.
 *  - A visitor who arrived as a buyer (thank-you link, session id, or a
 *    remembered purchase) is never shown the paywall. If Stripe cannot be
 *    asked they get the report; if Stripe finds nothing they get a screen
 *    that says so, with a retry and a support contact. See decideReportAccess.
 *  - Calendly ($497 / $1,997 / $4,997): paid inside Calendly's hosted flow and
 *    recorded server-side in Cosmos DB via the Calendly webhook / thank-you page.
 *    Verified SERVER-SIDE via /api/stripe/verify-session checking Cosmos DB.
 *    URL parameters (?tier=...) never grant client-side access on their own.
 */
function ReportRouter() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get("session_id")
  const paidParam = searchParams.get("paid") === "1"
  const { state, isHydrated } = useChallenge()
  const [verifyRun, setVerifyRun] = useState(0)
  // Review-only preview: `?preview` shows a password gate. The password is
  // verified SERVER-SIDE (verify-session's previewSecret branch), so a customer
  // who guesses the URL just sees a locked prompt they can't pass. It unlocks
  // the same layout with whatever real report data is in the viewer's session.
  const previewMode = searchParams.has("preview")
  const [access, setAccess] = useState<Access>(previewMode ? "denied" : "checking")
  const [previewPassword, setPreviewPassword] = useState("")
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewChecking, setPreviewChecking] = useState(false)

  useEffect(() => {
    // In preview mode we wait for the admin to submit the password (below)
    // rather than running the Stripe/tier checks.
    if (previewMode) return

    let cancelled = false

    // Stripe/Cosmos verification path. The buyer's email and serial live in the
    // funnel state, so wait for it to load from localStorage before asking.
    if (!isHydrated) return

    const remembered = recallPurchase()
    const proofSessionId = sessionId ?? remembered?.sessionId ?? undefined
    const email = state.email?.trim() || undefined
    const arrivedAsBuyer = paidParam || Boolean(sessionId) || Boolean(remembered)

    const settle = (decision: ReportAccess, via: string) => {
      if (cancelled) return
      setAccess(decision)
      try {
        posthog.capture("report_access", {
          decision,
          via,
          arrived_as_buyer: arrivedAsBuyer,
          had_session_id: Boolean(proofSessionId),
        })
      } catch {
        /* posthog not initialized */
      }
    }

    if (!proofSessionId && !email) {
      settle(arrivedAsBuyer ? "unconfirmed" : "denied", "no-proof")
      return
    }

    setAccess("checking")
    verifyPurchase({
      sessionId: proofSessionId,
      email,
      serialNumber: state.serialNumber ?? undefined,
    }).then((r) => {
      settle(
        decideReportAccess({ ...r, arrivedAsBuyer }),
        r.paid ? "stripe" : r.unverifiable ? "unverifiable" : "not-found",
      )
    })

    return () => {
      cancelled = true
    }
  }, [sessionId, previewMode, paidParam, isHydrated, state.email, state.serialNumber, verifyRun])

  const recheck = useCallback(() => setVerifyRun((n) => n + 1), [])

  async function submitPreview(e: React.FormEvent) {
    e.preventDefault()
    if (previewChecking) return
    setPreviewChecking(true)
    setPreviewError(null)
    try {
      const r = await fetch("/api/stripe/verify-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewSecret: previewPassword }),
      })
      const d: { paid?: boolean } = await r.json()
      if (d?.paid) {
        setAccess("allowed")
      } else {
        setPreviewError("Incorrect password.")
      }
    } catch {
      setPreviewError("Could not verify. Try again.")
    } finally {
      setPreviewChecking(false)
    }
  }

  if (access === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <div className="flex items-center gap-3 text-foreground/70">
          <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.6} />
          <span className="text-sm">Confirming your purchase…</span>
        </div>
      </div>
    )
  }

  if (access === "allowed") return <ClarityReport preview={previewMode} />

  // Preview password gate — only shown on `?preview` and only while still
  // locked. Any other denied access falls through to the normal paywall.
  if (previewMode) {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <form
          onSubmit={submitPreview}
          className="w-full max-w-sm rounded-lg border border-border bg-card p-7 text-center"
        >
          <p className="font-serif text-[20px] leading-snug text-ink">
            Report preview
          </p>
          <p className="mx-auto mt-2 max-w-xs text-[13.5px] leading-[1.7] text-foreground/70">
            Enter the admin password to preview the report layout.
          </p>
          <input
            type="password"
            value={previewPassword}
            onChange={(e) => setPreviewPassword(e.target.value)}
            placeholder="Admin password"
            autoFocus
            className="mt-5 w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-ink outline-none focus:border-ink"
            aria-invalid={!!previewError}
          />
          {previewError && (
            <p role="alert" className="mt-2 text-[12.5px] text-destructive">
              {previewError}
            </p>
          )}
          <button
            type="submit"
            disabled={previewChecking || !previewPassword.trim()}
            className="mt-5 w-full rounded-full bg-ink px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.2em] text-background transition-opacity disabled:opacity-50"
          >
            {previewChecking ? "Checking…" : "Unlock preview"}
          </button>
        </form>
      </div>
    )
  }

  if (access === "unconfirmed") {
    return (
      <PaymentNotConfirmed
        firstName={state.firstName}
        email={state.email}
        serialNumber={state.serialNumber}
        onRecheck={recheck}
      />
    )
  }

  return <ReportPaywall />
}

/**
 * Shown to a visitor who arrived as a buyer but whose payment Stripe could not
 * match to this browser (paid on another device, changed the email at
 * checkout). Never a sales pitch: it says what happened, offers a re-check, and
 * gives a human to write to with the details support needs.
 */
function PaymentNotConfirmed({
  firstName,
  email,
  serialNumber,
  onRecheck,
}: {
  firstName: string
  email: string
  serialNumber: number | null
  onRecheck: () => void
}) {
  const subject = "Action Plan access after payment"
  const lines = [
    "Hi, I paid for my Action Plan but could not open it.",
    "",
    `Name: ${firstName}`,
    `Email used in the assessment: ${email}`,
  ]
  if (serialNumber) lines.push(`Reference: ${serialNumber}`)
  const body = lines.join("\n")
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-7 text-center">
        <p className="font-serif text-[21px] leading-snug text-ink">
          {firstName ? `${firstName}, we` : "We"} are confirming your payment.
        </p>
        <p className="mx-auto mt-3 text-[14px] leading-[1.7] text-foreground/75">
          We could not match your payment to this browser yet. Your payment is
          safe and you will not be charged again.
        </p>
        <p className="mx-auto mt-3 text-[14px] leading-[1.7] text-foreground/75">
          If you paid on another device or with a different email, open this
          page there, or write to us and we will send your Action Plan
          directly.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={onRecheck}
            className="rounded-full bg-ink px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.2em] text-background"
          >
            Check again
          </button>
          <a
            href={mailto}
            className="rounded-full border border-border px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.2em] text-ink"
          >
            Email us
          </a>
        </div>
        <p className="mt-4 text-[12.5px] text-foreground/60">{SUPPORT_EMAIL}</p>
      </div>
    </div>
  )
}

export function ClarityReportShell() {
  return (
    <div data-palette="marine" className="bg-background text-foreground font-sans">
      <Suspense fallback={null}>
        <ReportRouter />
      </Suspense>
    </div>
  )
}
