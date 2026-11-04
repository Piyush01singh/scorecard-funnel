"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowRight, Download, Loader2, Shield } from "lucide-react"
import { useChallenge } from "@/context/challenge-context"
import { displayFor } from "@/lib/vertical-display"
import { isFunnelEnforced } from "@/lib/funnel-guard"
import {
  getCachedSummaryAudio,
  preloadSummaryAudio,
} from "@/lib/client/summary-audio-cache"
import { FB_PIXEL_ID, trackWhenReady } from "@/lib/fbpixel"
import { persistTelemetry } from "@/lib/persist-outputs"
import { rememberPurchase } from "@/lib/client/purchase-proof"
import { funnelOriginToReturnTo } from "@/lib/client/funnel-origin"

// Thank-you page - confirms successful transactions from both
// Stripe ($47 report) and the deeper tiers booked via Calendly.
// The view adapts to the source via the URL:
//
//   ?paid=1                        → Stripe success ($47 Read The Pattern)
//   ?booked=1&tier=session         → $497 Hear Your Story
//   ?booked=1&tier=transformation  → $1,997 Believe Yourself (Protocol)
//   ?booked=1&tier=elevated        → $4,997 Build From That Belief
//
// Every tier includes the report + audio summary, so the
// downloads section is shared across all tiers.

type SuccessTier = "diagnostic" | "session" | "transformation" | "elevated"

interface TierCopy {
  eyebrow: string
  headLead: string
  headEmphasis: string
  body: string[]
  /** Report download card copy (per-tier framing per the spec). */
  reportTitle: string
  reportTitleItalic: string
  reportCta: string
  reportNote: string
  /** Optional low-key footer pointer - diagnostic tier only. */
  footerLine?: string
}

// Copy is per the "Thank-you pages" spec. Tone differs by tier; the report is
// the single deliverable framed on every page (no on-page upsell).
// Parameterized by the vertical's product name (One-Name Law: an ADHD buyer
// is thanked for their ADHD Belief Score, a healthcare leader for their
// Belief Profile).
const tierCopyFor = (
  productName: string,
  reportName: string,
  isB2B: boolean,
): Record<SuccessTier, TierCopy> => ({
  diagnostic: {
    eyebrow: isB2B ? `Your ${reportName} is ready` : `Your ${productName} is ready`,
    headLead: isB2B ? `Your ${reportName} is` : `Your ${productName} is`,
    headEmphasis: isB2B ? "ready." : "composed.",
    body: isB2B
      ? [
          // Operational register - the B2B strategy bans psychology
          // vocabulary in every written asset, and this page is the first
          // thing a buyer reads after paying.
          "The operating pattern you described is now written up: the loop, the one intervention point, the stakeholder and governance view, and a bounded first-proof you can run inside 30 days.",
          "Start with the leadership briefing - it is built to be forwarded, so you do not have to translate any of this for your executive team.",
        ]
      : [
          // Four scored dimensions, not seven. The old copy named a pillar
          // count the product has never rendered.
          "What you felt but couldn't name is now on the page - the specific pattern running quietly underneath your effort, read across all four scored dimensions.",
          "Take your time with it. It does not need to be repeated to be remembered.",
        ],
    reportTitle: "Download your action plan",
    reportTitleItalic: isB2B ? "and the leadership briefing." : "your full action plan.",
    reportCta: "Download your action plan",
    reportNote: isB2B
      ? "A copy is also on its way to your inbox. A member of our team reviews each Action Plan for quality before it reaches you. If it hasn't arrived shortly, check your spam folder."
      : "A copy is also on its way to your inbox. If it hasn't arrived in a few minutes, check your spam folder - then add us to your contacts so the next one lands.",
    // B2B gets no post-purchase nudge at all: "nobody calls you" is a
    // promise made on the offer page, and the Sprint is named once, in the
    // Action Plan itself.
    footerLine: isB2B
      ? undefined
      : "When you're ready to go deeper, there's a conversation available. No hurry.",
  },
  session: {
    eyebrow: "Payment received · Your Story is on the way",
    headLead: "Thank you.",
    headEmphasis: "Your Story is being written.",
    body: [
      `This is where your ${productName} stops being a page and becomes a narrative - your Purpose Story, built from your actual life and returned to you in your own words.`,
      "First, your action plan. Download it below - the steps to submit the details for your Story are on their way to your inbox, and your action plan is the ground it's built on.",
    ],
    reportTitle: "Your action plan -",
    reportTitleItalic: "the ground your Story is built on.",
    reportCta: "Download your action plan",
    reportNote:
      "Your Story submission steps and a copy of the action plan are on their way to your inbox. If they haven't arrived in a few minutes, check your spam folder - then add us to your contacts so the next one lands.",
  },
  transformation: {
    eyebrow: "Payment received · Your Protocol is reserved",
    headLead: "Thank you.",
    headEmphasis: "The four weeks are yours.",
    body: [
      "What you've reserved is the full arc - four personalised narratives, an intake with a trained practitioner, and the 28-day Signal Wall that makes your own change visible.",
      "Start with your action plan. Download it below and sit with it before your intake; it's the map the Protocol works from.",
    ],
    reportTitle: "Your action plan -",
    reportTitleItalic: "the map your Protocol works from.",
    reportCta: "Download your action plan",
    reportNote:
      "Your intake details and a copy of the action plan are on their way to your inbox. If anything needs to change, the reschedule link is in that email - and check your spam folder if it hasn't arrived shortly.",
  },
  elevated: {
    eyebrow: "Payment received · Your Elevated experience is reserved",
    headLead: "Thank you.",
    headEmphasis: "This is the full container.",
    body: [
      "Eight weeks, produced - your narratives layered with original music, direct access to your practitioner throughout, and a shareable version your family can hear.",
      "Start with your action plan. Download it below and sit with it before your intake; it's where the whole arc begins.",
    ],
    reportTitle: "Your action plan -",
    reportTitleItalic: "where the whole arc begins.",
    reportCta: "Download your action plan",
    reportNote:
      "Your intake details and a copy of the action plan are on their way to your inbox. If the timing needs to shift, the reschedule link is in that email - and check your spam folder if it hasn't arrived shortly.",
  },
})

// Facebook "Purchase" value per tier (USD). Firing this on the thank-you page
// is what lets the ad algorithm learn which clicks convert - see the spec.
const TIER_VALUE: Record<SuccessTier, number> = {
  diagnostic: 47,
  session: 497,
  transformation: 1997,
  elevated: 4997,
}

function resolveTier(): SuccessTier {
  if (typeof window === "undefined") return "diagnostic"
  const params = new URLSearchParams(window.location.search)
  const t = params.get("tier")
  if (t === "session" || t === "transformation" || t === "elevated") return t
  return "diagnostic"
}

export default function ThankYouPage() {
  const router = useRouter()
  const { state, markComplete } = useChallenge()
  const [isDownloadingAudio, setIsDownloadingAudio] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const [tier, setTier] = useState<SuccessTier>("diagnostic")
  // Stripe's session_id is forwarded to the report so it can verify payment
  // server-side (the report no longer trusts a bare ?paid=1).
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Stripe sends every buyer to one fixed success URL, but the assessment
  // lives in the localStorage of the subdomain they took it on. When that is
  // a different origin, reload there with the same query string before
  // anything else runs - otherwise this page and the report see an empty
  // session. Resolved once; every effect below stands down while it's set.
  const returnOriginRef = useRef<string | null | undefined>(undefined)
  const returningToFunnel = () => {
    if (returnOriginRef.current === undefined) {
      returnOriginRef.current =
        typeof window === "undefined" ? null : funnelOriginToReturnTo()
    }
    return returnOriginRef.current !== null
  }

  // Resolved on mount so SSR hydration doesn't mismatch.
  useEffect(() => {
    if (returningToFunnel()) {
      const { pathname, search, hash } = window.location
      window.location.replace(`${returnOriginRef.current}${pathname}${search}${hash}`)
      return
    }
    const params = new URLSearchParams(window.location.search)
    const sid = params.get("session_id")
    setTier(resolveTier())
    setSessionId(sid)
    // Remember the purchase for the report gate, so the report still opens as
    // a buyer's report later or from a link that lost its session_id.
    if (params.get("paid") === "1" || params.get("booked") === "1") {
      rememberPurchase({ sessionId: sid ?? undefined, tier: resolveTier() })
    }
  }, [])

  // Direct-access guard: this is a post-transaction confirmation page. When
  // funnel enforcement is on, a visit without a payment/booking signal is
  // someone typing the URL - send them home. (The paid report itself is
  // separately protected by server-side verification, so this is just order
  // hygiene, not the security boundary.)
  useEffect(() => {
    if (returningToFunnel()) return
    if (!isFunnelEnforced()) return
    const params = new URLSearchParams(window.location.search)
    const hasSignal =
      params.get("paid") === "1" || params.get("booked") === "1"
    if (!hasSignal) router.replace("/")
  }, [router])

  const display = displayFor(state.audience)
  const productName = display.productName
  const copy = tierCopyFor(
    productName,
    display.reportName,
    display.offerVariant === "b2b",
  )[tier]

  useEffect(() => {
    if (returningToFunnel()) return
    markComplete()
  }, [markComplete])

  // Refresh PostHog telemetry for /techadmin analytics.
  // Reached only post-transaction; uses the buyer's serial number from context
  // (same browser as the funnel). Purchases are recorded authoritatively via
  // server-side webhooks (Stripe / Calendly) rather than client-side (fixes #12).
  const recordedRef = useRef(false)
  useEffect(() => {
    if (recordedRef.current) return
    if (returningToFunnel()) return
    if (!state.serialNumber || !state.email) return
    const params = new URLSearchParams(window.location.search)
    const confirmed = params.get("paid") === "1" || params.get("booked") === "1"
    if (!confirmed) return
    recordedRef.current = true
    const identity = {
      serialNumber: state.serialNumber,
      firstName: state.firstName,
      email: state.email,
    }
    persistTelemetry(identity)
  }, [state.serialNumber, state.email, state.firstName])

  // Fire the Facebook "Purchase" pixel once, with the tier's value - this is
  // what lets the ad algorithm learn which clicks convert (per the spec).
  // This page is reached only via a post-payment redirect (?paid=1 from
  // Stripe / ?booked=1 from Calendly); we require one of those flags so a
  // direct visit can never log a false purchase. Deduped per purchase (Stripe
  // session_id, else tier) for the tab session so a refresh doesn't recount.
  const purchaseFiredRef = useRef(false)
  useEffect(() => {
    if (purchaseFiredRef.current || !FB_PIXEL_ID) return
    if (returningToFunnel()) return
    const params = new URLSearchParams(window.location.search)
    // Calendly bookings have no Stripe session; Stripe success always carries
    // session_id. Requiring it for the paid (Stripe) path means a forged bare
    // ?paid=1 can't fire a false Purchase and pollute ad optimization.
    const sid = params.get("session_id")
    const confirmed =
      params.get("booked") === "1" ||
      (params.get("paid") === "1" && !!sid)
    if (!confirmed) return
    const resolved = resolveTier()
    // Shared id for Meta deduplication: the Stripe webhook fires CAPI with the
    // checkout session id; the Calendly webhook fires CAPI with the invitee
    // uuid (which Calendly also appends to this redirect as `invitee_uuid`).
    // Passing the same id on the browser pixel lets Meta collapse the two into
    // one Purchase. Falls back to the tier when no id is present (e.g. a
    // Calendly plan that strips the param) - still fires, just not deduped.
    const eventId =
      sid ?? params.get("invitee_uuid") ?? `unfair-advantage-${resolved}`
    const dedupKey = `fb-purchase:${eventId}`
    try {
      if (sessionStorage.getItem(dedupKey)) {
        purchaseFiredRef.current = true
        return
      }
    } catch {
      /* sessionStorage blocked - fall through and fire once per mount */
    }
    purchaseFiredRef.current = true
    trackWhenReady(
      "Purchase",
      {
        value: TIER_VALUE[resolved],
        currency: "USD",
        content_name: `unfair-advantage-${resolved}`,
      },
      eventId,
    )
    try {
      sessionStorage.setItem(dedupKey, "1")
    } catch {
      /* ignore */
    }
  }, [])

  const safeName = useMemo(() => {
    const base = (state.firstName || "your")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30)
    return base || "your"
  }, [state.firstName])

  const handleAudioDownload = async () => {
    if (isDownloadingAudio) return
    const text = state.summaryText?.trim()
    if (!text) {
      setAudioError(
        "Your audio summary isn't ready yet - refresh in a moment and try again.",
      )
      return
    }
    setIsDownloadingAudio(true)
    setAudioError(null)
    try {
      const pending =
        getCachedSummaryAudio(text) ?? preloadSummaryAudio(text)
      const buffer = await pending
      if (!buffer) throw new Error("empty buffer")
      const blob = new Blob([buffer.slice(0)], { type: "audio/mpeg" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${safeName}-clarity-audio-summary.mp3`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      console.error("[thank-you] audio download failed", err)
      setAudioError("Couldn't prepare audio. Please try again in a moment.")
    } finally {
      setIsDownloadingAudio(false)
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <section className="px-5 pb-20 pt-16 sm:px-8 sm:pt-24">
        <div className="mx-auto max-w-2xl">
          <SuccessMark />

          <p
            className="stagger-enter eyebrow mb-5 flex items-center gap-3 text-foreground/70"
            style={{ animationDelay: "200ms" }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: "var(--signal)" }}
              aria-hidden
            />
            {copy.eyebrow}
          </p>

          <h1
            className="stagger-enter mb-6 font-serif text-[1.9rem] leading-[1.1] text-ink sm:text-[2.3rem] sm:leading-[1.06] md:text-[2.7rem]"
            style={{ animationDelay: "300ms" }}
          >
            {copy.headLead}
            <span className="block font-serif-italic text-foreground">
              {copy.headEmphasis}
            </span>
          </h1>

          <div
            className="stagger-enter mb-12 max-w-xl space-y-4 text-[16px] leading-[1.8] text-foreground/85"
            style={{ animationDelay: "400ms" }}
          >
            {copy.body.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>

          {/* Downloads */}
          <div
            className="stagger-enter space-y-4"
            style={{ animationDelay: "500ms" }}
          >
            <DownloadCard
              preview={<PdfPreview />}
              eyebrow="Your action plan · PDF"
              title={copy.reportTitle}
              titleItalic={copy.reportTitleItalic}
              description="Your full PDF action plan - your scores, the specific pattern named in plain language, three immediate behavioral shifts, and a 90-day benchmark to measure progress."
              actionHref={`/challenge/report?autosave=1&paid=1&tier=${tier}${
                sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""
              }`}
              actionLabel={copy.reportCta}
              primary
            />

            <DownloadCard
              preview={<AudioPreview />}
              eyebrow="Audio summary · MP3"
              title={`Your ${productName}, in voice -`}
              titleItalic="for listening, not reading."
              description="The personalized audio summary generated from your responses. Use it on walks, in transit, or anywhere the written page doesn't reach."
              actionLabel={
                isDownloadingAudio ? "Preparing…" : "Download audio"
              }
              actionLoading={isDownloadingAudio}
              onAction={handleAudioDownload}
              error={audioError}
            />
          </div>

          {/* Per-tier inbox/spam note (replaces the old generic line). */}
          <p
            className="stagger-enter mt-6 max-w-xl font-serif-italic text-[13.5px] leading-[1.7]"
            style={{
              animationDelay: "620ms",
              color: "color-mix(in srgb, var(--foreground) 62%, transparent)",
            }}
          >
            {copy.reportNote}
          </p>

          <p
            className="stagger-enter mt-5 flex items-center gap-2 text-[11px] uppercase tracking-[0.22em]"
            style={{
              animationDelay: "660ms",
              color: "color-mix(in srgb, var(--foreground) 55%, transparent)",
            }}
          >
            <Shield className="h-3 w-3" strokeWidth={1.5} />
            Yours to keep · download any time
          </p>

          {/* The single, low-key "go deeper" pointer allowed on the $47 page -
              no upsell cards, per the spec. */}
          {copy.footerLine && (
            <p
              className="stagger-enter mt-8 max-w-xl border-t pt-6 font-serif-italic text-[15px] leading-[1.7] text-foreground/70"
              style={{
                animationDelay: "720ms",
                borderColor: "color-mix(in srgb, var(--ink) 12%, transparent)",
              }}
            >
              {copy.footerLine}
            </p>
          )}

          <div
            className="stagger-enter mt-12 border-t pt-8"
            style={{
              animationDelay: "780ms",
              borderColor: "color-mix(in srgb, var(--ink) 14%, transparent)",
            }}
          >
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.22em] text-foreground/65 transition-colors hover:text-ink"
            >
              Return home
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.6} />
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}

// ──────────────────────────────────────────────────────────────
// Download card

function DownloadCard({
  preview,
  eyebrow,
  title,
  titleItalic,
  description,
  actionHref,
  actionLabel,
  actionLoading,
  onAction,
  error,
  primary,
}: {
  preview: React.ReactNode
  eyebrow: string
  title: string
  titleItalic: string
  description: string
  actionHref?: string
  actionLabel: string
  actionLoading?: boolean
  onAction?: () => void
  error?: string | null
  primary?: boolean
}) {
  const buttonStyles: React.CSSProperties = primary
    ? {
        background: "var(--signal)",
        color: "var(--background)",
        border:
          "1px solid color-mix(in srgb, var(--signal) 60%, transparent)",
        boxShadow: "0 14px 40px -16px rgba(var(--glow), 0.55)",
      }
    : {
        background: "transparent",
        color: "var(--ink)",
        border: "1px solid color-mix(in srgb, var(--ink) 28%, transparent)",
      }

  const button = (
    <button
      type="button"
      onClick={onAction}
      disabled={actionLoading}
      className="s-btn group/btn h-11 px-5 text-[12px] disabled:cursor-wait disabled:opacity-90"
      style={buttonStyles}
    >
      {actionLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.6} />
      ) : (
        <Download className="h-3.5 w-3.5" strokeWidth={1.6} />
      )}
      {actionLabel}
    </button>
  )

  return (
    <article
      className="relative rounded-md p-6 sm:p-7"
      style={{
        background: "color-mix(in srgb, var(--ink) 5%, transparent)",
        border: "1px solid color-mix(in srgb, var(--ink) 16%, transparent)",
      }}
    >
      <div className="flex items-start gap-5 sm:gap-6">
        {preview}

        <div className="min-w-0 flex-1">
          <p
            className="eyebrow mb-2"
            style={{
              color: "color-mix(in srgb, var(--foreground) 68%, transparent)",
            }}
          >
            {eyebrow}
          </p>
          <h3 className="mb-2 font-serif text-[18px] leading-[1.25] text-ink sm:text-[20px]">
            {title}
            <span className="block font-serif-italic text-foreground">
              {titleItalic}
            </span>
          </h3>
          <p className="mb-5 text-[14.5px] leading-[1.65] text-foreground/80">
            {description}
          </p>

          {actionHref ? (
            <Link
              href={actionHref}
              target="_blank"
              rel="noopener noreferrer"
              className="s-btn group/btn inline-flex h-11 items-center gap-2 px-5 text-[12px]"
              style={buttonStyles}
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.6} />
              {actionLabel}
            </Link>
          ) : (
            button
          )}

          {error && (
            <p
              className="mt-3 text-[13px] leading-snug"
              style={{
                color: "var(--ink)",
                background:
                  "color-mix(in srgb, var(--signal) 8%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--signal) 30%, transparent)",
                padding: "8px 12px",
                borderRadius: 6,
              }}
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </article>
  )
}

// ──────────────────────────────────────────────────────────────
// File previews - bespoke per-format visuals that read as
// "this is the artifact you bought" before the user even hits
// download. Decorative, palette-driven, marked aria-hidden.

function PdfPreview() {
  return (
    <div
      className="relative shrink-0"
      aria-hidden
      style={{ width: 84, height: 108 }}
    >
      {/* Stacked-page effect - two paper shadows sit behind the
          front sheet so the preview reads as a multi-page PDF
          rather than a single card. */}
      <div
        className="absolute rounded-sm"
        style={{
          inset: "10px -4px -4px 4px",
          background: "color-mix(in srgb, var(--card) 70%, transparent)",
          border: "1px solid color-mix(in srgb, var(--ink) 14%, transparent)",
        }}
      />
      <div
        className="absolute rounded-sm"
        style={{
          inset: "5px -2px -2px 2px",
          background: "color-mix(in srgb, var(--card) 88%, transparent)",
          border: "1px solid color-mix(in srgb, var(--ink) 18%, transparent)",
        }}
      />

      {/* Front sheet - content mock so the viewer reads
          "diagnostic report" without literally rendering one. */}
      <div
        className="absolute inset-0 overflow-hidden rounded-sm"
        style={{
          background: "color-mix(in srgb, var(--card) 100%, transparent)",
          border: "1px solid color-mix(in srgb, var(--ink) 24%, transparent)",
          boxShadow: "0 10px 22px -12px rgba(var(--shadow-ink), 0.45)",
        }}
      >
        <svg viewBox="0 0 84 108" width="84" height="108">
          {/* Signal-tinted title bar */}
          <rect
            x="9"
            y="13"
            width="36"
            height="2"
            rx="1"
            fill="var(--signal)"
            opacity="0.9"
          />

          {/* Score panel - the most recognizable element of the
              real report, miniaturized so it reads at a glance. */}
          <rect
            x="9"
            y="22"
            width="66"
            height="18"
            rx="1.5"
            fill="none"
            stroke="color-mix(in srgb, var(--signal) 40%, transparent)"
            strokeWidth="0.8"
          />
          <text
            x="13"
            y="33"
            style={{
              fontSize: "5.5px",
              letterSpacing: "0.8px",
              fill: "color-mix(in srgb, var(--signal) 75%, transparent)",
              fontFamily: "var(--font-fraunces), serif",
            }}
          >
            SCORE
          </text>
          <text
            x="72"
            y="35"
            textAnchor="end"
            style={{
              fontSize: "9px",
              fill: "var(--signal)",
              fontFamily: "var(--font-fraunces), serif",
              fontWeight: 500,
            }}
          >
            78
          </text>

          {/* Headline + body line mock */}
          {[
            { y: 48, w: 60 },
            { y: 53, w: 52 },
          ].map((row, i) => (
            <rect
              key={`h${i}`}
              x="9"
              y={row.y}
              width={row.w}
              height="1.8"
              rx="0.6"
              fill="color-mix(in srgb, var(--foreground) 38%, transparent)"
            />
          ))}

          {/* Section divider */}
          <rect
            x="9"
            y="63"
            width="66"
            height="0.5"
            fill="color-mix(in srgb, var(--foreground) 20%, transparent)"
          />

          {/* Pillar bars - four mini progress rows that gesture
              at the seven-pillar score breakdown in the real PDF. */}
          {[
            { y: 70, w: 48 },
            { y: 78, w: 38 },
            { y: 86, w: 54 },
            { y: 94, w: 30 },
          ].map((row, i) => (
            <g key={`p${i}`}>
              <rect
                x="9"
                y={row.y}
                width="66"
                height="1.2"
                rx="0.6"
                fill="color-mix(in srgb, var(--foreground) 12%, transparent)"
              />
              <rect
                x="9"
                y={row.y}
                width={row.w}
                height="1.2"
                rx="0.6"
                fill="color-mix(in srgb, var(--signal) 55%, transparent)"
              />
            </g>
          ))}
        </svg>
      </div>

      {/* Format badge - overlaps the front sheet's bottom-right */}
      <span
        className="absolute -bottom-1.5 -right-1.5 inline-flex h-5 items-center rounded-full px-2 text-[8.5px] font-semibold tracking-[0.18em]"
        style={{
          background: "var(--signal)",
          color: "var(--background)",
          letterSpacing: "0.18em",
          boxShadow: "0 4px 10px -4px rgba(var(--shadow-ink), 0.5)",
        }}
      >
        PDF
      </span>
    </div>
  )
}

function AudioPreview() {
  // Pre-baked waveform heights - symmetric-ish but irregular so
  // it doesn't read as a chart pattern. The center bars are
  // tallest, suggesting the loudest point of the audio.
  const bars = [
    14, 22, 16, 30, 24, 38, 28, 46, 34, 52, 40, 56, 44, 52, 36, 48, 28, 40, 22,
    32, 18, 26, 14,
  ]
  const center = (bars.length - 1) / 2

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-sm"
      aria-hidden
      style={{
        width: 84,
        height: 108,
        background:
          "linear-gradient(160deg, color-mix(in srgb, var(--signal) 18%, var(--card)) 0%, color-mix(in srgb, var(--signal) 6%, var(--card)) 100%)",
        border: "1px solid color-mix(in srgb, var(--signal) 32%, transparent)",
        boxShadow: "0 10px 22px -12px rgba(var(--shadow-ink), 0.45)",
      }}
    >
      {/* Soft halo behind the waveform */}
      <div
        className="absolute"
        style={{
          inset: "-30% -10% auto -10%",
          height: "85%",
          background:
            "radial-gradient(ellipse at 50% 60%, color-mix(in srgb, var(--signal) 28%, transparent) 0%, transparent 65%)",
        }}
      />

      {/* Concentric "needle-drop" ring - small play-disc cue */}
      <div
        className="absolute"
        style={{
          top: 10,
          left: "50%",
          transform: "translateX(-50%)",
          width: 22,
          height: 22,
          borderRadius: "50%",
          border:
            "1px solid color-mix(in srgb, var(--signal) 55%, transparent)",
        }}
      >
        <div
          className="absolute"
          style={{
            top: "50%",
            left: "50%",
            width: 6,
            height: 6,
            borderRadius: "50%",
            transform: "translate(-50%, -50%)",
            background: "var(--signal)",
          }}
        />
      </div>

      {/* Waveform - vertical bars, signal-tinted, center bars
          slightly more opaque to mimic a "playhead". */}
      <div
        className="absolute inset-x-0 flex items-center justify-center gap-[2px] px-2.5"
        style={{ bottom: 12, top: 42 }}
      >
        {bars.map((h, i) => {
          const dist = Math.abs(i - center)
          const opacity = 0.45 + (1 - dist / center) * 0.45
          return (
            <span
              key={i}
              className="block rounded-full"
              style={{
                width: 2,
                height: `${h}%`,
                background: "var(--signal)",
                opacity,
              }}
            />
          )
        })}
      </div>

      {/* Format badge */}
      <span
        className="absolute -bottom-1.5 -right-1.5 inline-flex h-5 items-center rounded-full px-2 text-[8.5px] font-semibold"
        style={{
          background: "var(--signal)",
          color: "var(--background)",
          letterSpacing: "0.18em",
          boxShadow: "0 4px 10px -4px rgba(var(--shadow-ink), 0.5)",
        }}
      >
        MP3
      </span>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Success mark - Apple-style draw-in. Circle traces, then the
// check traces inside it, then an outer ring begins a slow
// ambient pulse. All animations defined in globals.css so they
// honor prefers-reduced-motion centrally.

function SuccessMark() {
  return (
    <div className="mb-10 flex justify-center sm:mb-12">
      <svg
        viewBox="0 0 80 80"
        className="success-mark h-20 w-20 sm:h-24 sm:w-24"
        role="img"
        aria-label="Payment successful"
      >
        <circle
          className="ring"
          cx="40"
          cy="40"
          r="36"
          fill="none"
          stroke="var(--signal)"
          strokeWidth="0.5"
          opacity="0.32"
        />
        <circle
          className="circle"
          cx="40"
          cy="40"
          r="32"
          fill="none"
          stroke="var(--signal)"
          strokeWidth="1.5"
        />
        <path
          className="check"
          d="M26 42 L36 52 L54 30"
          fill="none"
          stroke="var(--signal)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
