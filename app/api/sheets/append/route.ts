import { NextResponse } from "next/server"
import { z } from "zod"
import { isCosmosConfigured, appendSignupRow, updateQuestionCell, updateFeedbackCell, updateBeatOutputCell, updateUserOutputs, updateUserTelemetry } from "@/lib/server/cosmos-db"
import { redactError } from "@/lib/security"
import { sendLeadEvent } from "@/lib/server/meta-capi"
import { normalizeVertical } from "@/lib/verticals"
import { FEEDBACK_MAX_CHARS } from "@/lib/feedback-limits"

/** Read a single cookie value out of the raw Cookie header. */
function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : undefined
}

const bodySchema = z.object({
  action: z.enum(["signup", "answer", "feedback", "beat_output", "score", "report", "summary", "telemetry", "offer_view"]),
  firstName: z.preprocess(
    (v) => (v == null ? "" : String(v).trim().slice(0, 200)),
    z.string().max(200)
  ),
  email: z.preprocess(
    (v) => (v == null ? "" : String(v).trim().slice(0, 320)),
    z.string().max(320).email("Invalid email format")
  ),
  // Optional WhatsApp/phone (signup action) for sales follow-up.
  phone: z.preprocess(
    (v) => (v == null ? undefined : String(v).trim().slice(0, 40)),
    z.string().max(40).optional()
  ),
  // Client-minted id (signup action) so the server Lead CAPI event dedups
  // against the browser Lead pixel that carries the same id.
  leadEventId: z.string().max(100).optional(),
  // Stored as-is on the signup row after normalization; legacy ids map to
  // "main" so reporting stays on one canonical vocabulary.
  audience: z
    .string()
    .max(40)
    .optional()
    .transform((v) => (v ? (normalizeVertical(v) ?? undefined) : undefined)),
  serialNumber: z.number().int().positive().optional(),
  questionNumber: z.number().int().min(1).max(5).optional(),
  answer: z.string().max(50000).optional(),
  // Snapshot of the prompt text shown to the user. Capped to keep documents
  // well under Cosmos's 2 MB item ceiling - admin question copy is short.
  questionText: z.preprocess(
    (v) => (v == null ? undefined : String(v)),
    z.string().max(4000).optional()
  ),
  beatNumber: z.number().int().min(1).max(5).optional(),
  // Clamped, never rejected. "Partly - close enough" opens a free-text note
  // that is sent as "<option> | <note>"; this used to be max(200), so any note
  // past ~176 chars failed validation, the client treated the 400 as permanent,
  // and the participant's choice for that beat was lost without a trace - the
  // likely cause of serial 203's blank beat 3 between saved beats 2 and 4. A
  // long note must cost its tail, not the whole answer.
  feedback: z.preprocess(
    (v) => (v == null ? undefined : String(v).slice(0, FEEDBACK_MAX_CHARS)),
    z.string().max(FEEDBACK_MAX_CHARS).optional()
  ),
  output: z.string().max(50000).optional(),
  // Final-output payloads. Caps are generous but bounded so a single
  // document stays well under Cosmos's 2 MB item limit. Audio is NOT sent
  // here (binary lives in Blob — see /api/challenge/persist-summary-audio).
  scoreJson: z.string().max(20000).optional(),
  reportJson: z.string().max(120000).optional(),
  summaryText: z.string().max(20000).optional(),
  // Tech-analytics telemetry.
  phSessionId: z.string().max(200).optional(),
  phDistinctId: z.string().max(200).optional(),
  // First-touch acquisition attribution (signup action only). Capped so a
  // signup can't bloat the document; server re-trims via sanitizeAttribution.
  attribution: z
    .object({
      utm_source: z.string().max(500).optional(),
      utm_medium: z.string().max(500).optional(),
      utm_campaign: z.string().max(500).optional(),
      utm_term: z.string().max(500).optional(),
      utm_content: z.string().max(500).optional(),
      // Ad-platform click IDs (which platform drove the click).
      fbclid: z.string().max(500).optional(),
      gclid: z.string().max(500).optional(),
      ttclid: z.string().max(500).optional(),
      msclkid: z.string().max(500).optional(),
      // Cross-reference back to the originating landing page + the vertical.
      ref: z.string().max(500).optional(),
      lp: z.string().max(500).optional(),
      vertical: z.string().max(500).optional(),
      referrer: z.string().max(500).optional(),
      landing_page: z.string().max(500).optional(),
    })
    .optional(),
})

export async function POST(request: Request) {
  if (!isCosmosConfigured()) {
    console.warn("[sheets/append] Skipped: Cosmos DB not configured.")
    return NextResponse.json({ ok: true, skipped: true, reason: "not_configured" })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { action, firstName, email, phone, leadEventId, audience, serialNumber, questionNumber, answer, questionText, beatNumber, feedback, output, scoreJson, reportJson, summaryText, phSessionId, phDistinctId, attribution } = parsed.data

  try {
    if (action === "signup") {
      // Reuses an incomplete row for the same email (patching name/audience/
      // phone) or creates a fresh one. The audience page relies on this:
      // step 1 writes the lead with audience "individual", step 2 re-submits
      // with the real choice and lands on the same row. Returns the S.No.
      const sno = await appendSignupRow(firstName, email, audience ?? "", attribution, phone)

      // Server-side Lead (Conversions API backstop for the browser pixel). This
      // signup request is same-origin, so we can read the visitor's _fbp/_fbc
      // cookies + IP/UA for high-quality advanced matching, and hash their
      // email/phone server-side. Deduped against the browser Lead via the
      // shared client-minted event id. No-op when CAPI isn't configured.
      if (leadEventId) {
        const cookie = request.headers.get("cookie")
        await sendLeadEvent({
          eventId: leadEventId,
          contentName: "belief-score-signup",
          eventSourceUrl: request.headers.get("referer"),
          user: {
            email,
            phone,
            firstName,
            fbp: readCookie(cookie, "_fbp"),
            fbc: readCookie(cookie, "_fbc"),
            clientIp:
              request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
              request.headers.get("x-real-ip"),
            userAgent: request.headers.get("user-agent"),
          },
        })
      }

      return NextResponse.json({ ok: true, serialNumber: sno })
    } else if (action === "answer" && questionNumber && answer !== undefined) {
      if (!serialNumber) {
        return NextResponse.json(
          { ok: false, error: "Missing serialNumber for answer action" },
          { status: 400 }
        )
      }
      await updateQuestionCell(serialNumber, firstName, email, questionNumber, answer, questionText)
    } else if (action === "feedback" && beatNumber && feedback) {
      if (!serialNumber) {
        return NextResponse.json(
          { ok: false, error: "Missing serialNumber for feedback action" },
          { status: 400 }
        )
      }
      await updateFeedbackCell(serialNumber, firstName, email, beatNumber, feedback)
    } else if (action === "beat_output" && beatNumber && output !== undefined) {
      if (!serialNumber) {
        console.warn("[sheets/append] beat_output missing serialNumber for beat", beatNumber)
        return NextResponse.json(
          { ok: false, error: "Missing serialNumber for beat_output action" },
          { status: 400 }
        )
      }
      console.log("[sheets/append] Saving beat_output:", { serialNumber, beatNumber, outputLen: output.length })
      await updateBeatOutputCell(serialNumber, firstName, email, beatNumber, output)
    } else if (action === "score" || action === "report" || action === "summary") {
      if (!serialNumber) {
        return NextResponse.json(
          { ok: false, error: `Missing serialNumber for ${action} action` },
          { status: 400 }
        )
      }
      const outputs: Record<string, string> = {}
      if (action === "score" && scoreJson !== undefined) outputs.score_json = scoreJson
      if (action === "report" && reportJson !== undefined) outputs.report_json = reportJson
      if (action === "summary" && summaryText !== undefined) outputs.summary_text = summaryText
      if (Object.keys(outputs).length === 0) {
        return NextResponse.json(
          { ok: false, error: `Missing payload for ${action} action` },
          { status: 400 }
        )
      }
      await updateUserOutputs(serialNumber, firstName, email, outputs)
    } else if (action === "offer_view") {
      // Funnel-visibility only: stamps when this lead reached the offer
      // page, so the journey can show reached-the-offer separately from
      // purchased - the funnel's single biggest drop-off. Repeat visits
      // refresh the timestamp; presence is what the journey reads.
      if (!serialNumber) {
        return NextResponse.json(
          { ok: false, error: "Missing serialNumber for offer_view action" },
          { status: 400 }
        )
      }
      await updateUserOutputs(serialNumber, firstName, email, {
        offer_viewed_at: new Date().toISOString(),
      })
    } else if (action === "telemetry") {
      if (!serialNumber) {
        return NextResponse.json(
          { ok: false, error: "Missing serialNumber for telemetry action" },
          { status: 400 }
        )
      }
      await updateUserTelemetry(serialNumber, firstName, email, {
        ph_session_id: phSessionId,
        ph_distinct_id: phDistinctId,
      })

    }
  } catch (e) {
    console.error("[sheets/append]", redactError(e))
    return NextResponse.json(
      { ok: false, error: "Failed to write to database" },
      { status: 502 }
    )
  }

  return NextResponse.json({ ok: true })
}
