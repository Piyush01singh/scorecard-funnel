"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import posthog from "posthog-js"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  DEFAULT_REPORT_SYSTEM_PROMPT,
  DEFAULT_REPORT_USER_PROMPT,
} from "@/lib/default-report-prompt"
import {
  DEFAULT_SCORE_SYSTEM_PROMPT,
  DEFAULT_SCORE_USER_PROMPT,
} from "@/lib/default-score-prompt"
import {
  DEFAULT_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_SUMMARY_USER_PROMPT,
} from "@/lib/default-summary-prompt"
import {
  ChevronDown,
  Save,
  Lock,
  Copy,
  Check,
  Search,
  Download,
  Upload,
  X,
  Filter,
  FileText,
  Volume2,
  Loader2,
  Trash2,
  MessageCircle,
  LogOut,
} from "lucide-react"
import {
  ReportView,
  downloadReportPdf,
  reportFileSlug,
  type ApiResponse as ReportApiResponse,
} from "@/components/challenge/clarity-report"
import type { ClarityScore } from "@/lib/scoring"
import type { FunnelStats } from "@/lib/server/cosmos-db"
import { DEFAULT_ENTRY_CONTENT, type EntryContent } from "@/lib/entry-content"
import { VERTICALS, VERTICAL_LABELS, normalizeVertical, type Vertical } from "@/lib/verticals"

// The editor's "audience" IS the vertical (main / retargeting / adhd /
// healthcare). Non-main verticals inherit any empty field from Main at
// runtime, so seeding a vertical means overriding only what differs.
type Audience = Vertical

/** Shape of the persisted score_json blob written by the summary screen. */
type PersistedScore = {
  clarity: ClarityScore
  reasons?: Partial<Record<string, string>>
  nsState?: string
  scoreSource?: "llm" | "fallback"
}

function tryParseJson<T>(raw?: string): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Plain-language explainer shown at the top of each prompt-editing tab, so
 *  non-technical team members understand what they're editing, where it shows
 *  up for the user, and the System-vs-User distinction. */
function PromptHelp({
  what,
  where,
  placeholders,
}: {
  what: React.ReactNode
  where: React.ReactNode
  placeholders?: string[]
}) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-4 space-y-2.5 text-[14px] leading-[1.65] text-foreground/85">
      <p className="text-foreground">{what}</p>
      <p>
        <span className="font-semibold text-foreground">Where it shows up: </span>
        <span className="text-foreground/75">{where}</span>
      </p>
      <p className="text-foreground/75">
        Each box below is one half of the AI instruction. The{" "}
        <strong className="text-foreground">System prompt</strong> is the AI&apos;s
        rulebook - its role, the rules it follows, and the exact format it must
        return. The <strong className="text-foreground">User prompt</strong> is the
        message we fill in with this person&apos;s answers; the{" "}
        <code className="px-1 py-0.5 rounded bg-card border border-border font-mono text-xs">{"{{tags}}"}</code>{" "}
        are swapped in automatically.
      </p>
      {placeholders && placeholders.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-foreground/75">
          <span className="font-semibold text-foreground">Placeholders:</span>
          {placeholders.map((p) => (
            <code
              key={p}
              className="px-1.5 py-0.5 rounded bg-card border border-border font-mono text-xs"
            >
              {p}
            </code>
          ))}
        </p>
      )}
    </div>
  )
}

/** Read-only render of a persisted score: overall, band, and the four
 *  weighted subscores with their per-pillar reasons. */
function ScoreBreakdown({ score }: { score: PersistedScore }) {
  const c = score.clarity
  const reasons = (score.reasons ?? {}) as Record<string, string | undefined>
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-bold text-3xl tabular-nums text-ink">{c.overall}</span>
        <span className="text-muted-foreground text-sm">/ 100</span>
        <Badge variant="outline" className="rounded-full text-[10px] uppercase tracking-[0.18em] border-ink/20 text-ink">
          {c.bandLabel}
        </Badge>
        {score.scoreSource && (
          <Badge variant="secondary" className="rounded-lg text-[10px] uppercase tracking-[0.18em]">
            {score.scoreSource === "llm" ? "LLM-scored" : "Heuristic fallback"}
          </Badge>
        )}
        {score.nsState && score.nsState !== "UNKNOWN" && (
          <Badge variant="outline" className="rounded-full text-[10px] uppercase tracking-[0.18em]">
            {score.nsState}
          </Badge>
        )}
      </div>
      <div className="space-y-2">
        {c.subscoreDetails?.map((s) => (
          <div key={s.key} className="text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground">
                {s.label}
                <span className="text-muted-foreground"> · {Math.round(s.weight * 100)}% weight</span>
              </span>
              <span className="font-bold tabular-nums text-ink">{s.value}</span>
            </div>
            {reasons[s.key] && (
              <p className="mt-0.5 text-[13px] text-muted-foreground leading-relaxed">{reasons[s.key]}</p>
            )}
          </div>
        ))}
      </div>
      {c.comparisonLabel && (
        <p className="text-[13px] text-muted-foreground leading-relaxed border-t border-border/60 pt-2">
          {c.comparisonLabel}
        </p>
      )}
    </div>
  )
}

/** The "Generated Outputs" block appended to each expanded response: score
 *  breakdown, summary (text + audio), and a report preview/PDF launcher. */
function ResponseOutputs({
  r,
  onViewReport,
}: {
  r: {
    id: string
    firstName: string
    createdAt: string
    score_json?: string
    report_json?: string
    summary_text?: string
    summary_audio_url?: string
  }
  onViewReport: (data: ReportApiResponse, name: string, id: string, dateISO: string) => void
}) {
  const score = tryParseJson<PersistedScore>(r.score_json)
  const report = tryParseJson<ReportApiResponse>(r.report_json)
  const hasAny =
    !!score?.clarity || !!report?.report || !!r.summary_text || !!r.summary_audio_url

  return (
    <>
      <Separator />
      <p className="eyebrow text-foreground/65 pb-1.5 border-b border-border">
        Generated Outputs
      </p>

      {!hasAny && (
        <p className="text-muted-foreground italic text-sm">
          No outputs captured yet - the tester hasn&apos;t reached the summary
          stage, or this submission predates output capture.
        </p>
      )}

      {score?.clarity && (
        <div>
          <label className="block eyebrow text-foreground/65 mb-1.5">Belief Score</label>
          <ScoreBreakdown score={score} />
        </div>
      )}

      {(r.summary_text || r.summary_audio_url) && (
        <div>
          <label className="block eyebrow text-foreground/65 mb-1.5">Summary</label>
          {r.summary_text && (
            <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto bg-muted/30 border border-border rounded-xl p-3">
              {r.summary_text}
            </div>
          )}
          {r.summary_audio_url ? (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio controls preload="none" src={r.summary_audio_url} className="h-9 max-w-full" />
              <a
                href={r.summary_audio_url}
                download
                className="inline-flex items-center gap-1.5 text-xs text-ink hover:underline"
              >
                <Volume2 className="w-3.5 h-3.5" />
                Download MP3
              </a>
            </div>
          ) : (
            <p className="mt-2 text-xs italic text-muted-foreground">
              Audio not captured (Blob store not configured, or the tester never played it).
            </p>
          )}
        </div>
      )}

      {report?.report && (
        <div>
          <label className="block eyebrow text-foreground/65 mb-1.5">Report</label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onViewReport(report, r.firstName, r.id, r.createdAt)}
            className="h-9 rounded-full border border-foreground/35 text-foreground hover:border-ink hover:text-ink text-[10px] uppercase tracking-[0.2em] px-4"
          >
            <FileText className="w-3.5 h-3.5 mr-1.5" />
            View report &amp; download PDF
          </Button>
        </div>
      )}
    </>
  )
}

type Question = {
  stageFraming: string
  question: string
  prompt: string
  hintBox: string
  placeholder: string
  quoteZone: string
}

type Beat = {
  label: string
  title: string
  subtitle: string
  feedbackQuestion: string
  systemContext: string
  userPrompt: string
}

type AudienceData = {
  systemPrompt: string
  reportSystemPrompt: string
  reportUserPrompt: string
  scoreSystemPrompt: string
  scoreUserPrompt: string
  summarySystemPrompt: string
  summaryUserPrompt: string
  questions: Question[]
  beats: Beat[]
  /** Static entry-page copy (the "your details" signup step). Empty string
   *  fields on non-main verticals inherit Main's value at runtime. */
  entryContent: EntryContent
}

const EMPTY_QUESTIONS: Question[] = Array.from({ length: 5 }, () => ({
  stageFraming: "",
  question: "",
  prompt: "",
  hintBox: "",
  placeholder: "",
  quoteZone: "",
}))

const EMPTY_BEATS: Beat[] = Array.from({ length: 5 }, () => ({
  label: "",
  title: "",
  subtitle: "",
  feedbackQuestion: "",
  systemContext: "",
  userPrompt: "",
}))

const EMPTY_ENTRY_DRAFT: EntryContent = {
  eyebrow: "",
  headline: "",
  headlineAccent: "",
  subcopy: "",
  ctaLabel: "",
  showVideo: true,
}

/**
 * Main starts from the shipped defaults (it's the base every vertical
 * inherits from); non-main verticals start EMPTY so an untouched field
 * keeps inheriting Main instead of freezing a copy of today's defaults.
 */
const emptyAudienceData = (isMain: boolean): AudienceData => ({
  systemPrompt: "",
  reportSystemPrompt: isMain ? DEFAULT_REPORT_SYSTEM_PROMPT : "",
  reportUserPrompt: isMain ? DEFAULT_REPORT_USER_PROMPT : "",
  scoreSystemPrompt: isMain ? DEFAULT_SCORE_SYSTEM_PROMPT : "",
  scoreUserPrompt: isMain ? DEFAULT_SCORE_USER_PROMPT : "",
  summarySystemPrompt: isMain ? DEFAULT_SUMMARY_SYSTEM_PROMPT : "",
  summaryUserPrompt: isMain ? DEFAULT_SUMMARY_USER_PROMPT : "",
  questions: structuredClone(EMPTY_QUESTIONS),
  beats: structuredClone(EMPTY_BEATS),
  entryContent: isMain ? { ...DEFAULT_ENTRY_CONTENT } : { ...EMPTY_ENTRY_DRAFT },
})

const emptyAllVerticals = (): Record<Audience, AudienceData> =>
  Object.fromEntries(
    VERTICALS.map((v) => [v, emptyAudienceData(v === "main")])
  ) as Record<Audience, AudienceData>

const TAGS = ["{{NAME}}", "{{Q1}}", "{{Q2}}", "{{Q3}}", "{{Q4}}", "{{Q5}}", "{{GATE2}}", "{{GATE4}}"] as const

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

// ── /techadmin analytics ──────────────────────────────────────────────

const cellFilled = (v?: string) => typeof v === "string" && v.trim().length > 0

const FUNNEL_STEPS: Array<{ key: keyof FunnelStats["stages"]; label: string }> = [
  { key: "signedUp", label: "Signed up" },
  { key: "answeredQ1", label: "Started (Q1)" },
  { key: "answeredAll", label: "Finished Qs" },
  { key: "reachedBeats", label: "Reflections" },
  { key: "scored", label: "Scored" },
  { key: "reported", label: "Report" },
  { key: "summarized", label: "Summary" },
  { key: "purchased", label: "Purchased" },
]

const pctOf = (n: number, of: number) =>
  of ? `${Math.round((n / of) * 1000) / 10}%` : "0%"

const phHost = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "").replace(/\/$/, "")
const phProject = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID
function posthogReplayUrl(sessionId?: string): string | null {
  if (!phHost) return null
  if (phProject && sessionId) return `${phHost}/project/${phProject}/replay/${sessionId}`
  return `${phHost}/replay`
}

/** True when a referrer string is a clickable http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

/** Click-to-copy chip for an id (session/distinct). */
function CopyChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-foreground/85 transition-colors hover:border-ink"
    >
      <span className="shrink-0 text-foreground/50">{label}:</span>
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-green-600" />
      ) : (
        <Copy className="h-3 w-3 shrink-0 opacity-60" />
      )}
    </button>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <p className="eyebrow text-foreground/60">{label}</p>
      <p className="mt-1 font-serif text-2xl tabular-nums text-ink">{value}</p>
      {sub && <p className="text-[12px] text-foreground/60">{sub}</p>}
    </div>
  )
}

/** Funnel analytics dashboard (tech console only). */
function AnalyticsPanel() {
  const [stats, setStats] = useState<FunnelStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/admin/stats")
      if (res.status === 401) throw new Error("Unauthorized")
      if (!res.ok) throw new Error("HTTP " + res.status)
      const json = await res.json()
      if (json.ok && json.stats) setStats(json.stats as FunnelStats)
      else throw new Error(json.error || "Failed to load stats")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const total = stats?.total ?? 0

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-secondary/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="font-medium text-foreground">Funnel analytics</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="h-8 rounded-full border-foreground/35 px-3 text-[10px] uppercase tracking-[0.18em] hover:border-ink hover:text-ink"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <p className="mt-1 text-[14px] leading-[1.65] text-foreground/70">
          Stage-by-stage conversion across all testers. Granular per-page paths
          live in PostHog - use the session link on each response (User
          responses tab).
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!stats && loading && (
        // Skeleton mirrors the loaded layout: 4 KPI cards + the funnel bars,
        // so the panel doesn't jump when data lands.
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="rounded-md border border-border bg-card p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-7 w-14" />
              </div>
            ))}
          </div>
          <div className="space-y-4 rounded-md border border-border bg-card p-5">
            <Skeleton className="h-3 w-32" />
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-2.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        </>
      )}

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Total testers" value={String(stats.total)} />
            <Kpi
              label="Completed funnel"
              value={String(stats.stages.summarized)}
              sub={pctOf(stats.stages.summarized, total)}
            />
            <Kpi
              label="Purchases"
              value={String(stats.stages.purchased)}
              sub={pctOf(stats.stages.purchased, total)}
            />
            <Kpi label="Revenue" value={`$${stats.revenue.toLocaleString()}`} />
          </div>

          <div className="space-y-3 rounded-md border border-border bg-card p-5">
            <p className="eyebrow mb-1 text-foreground/65">Conversion funnel</p>
            {FUNNEL_STEPS.map((step, i) => {
              const count = stats.stages[step.key]
              const prev = i === 0 ? count : stats.stages[FUNNEL_STEPS[i - 1].key]
              const widthPct = total ? Math.max(2, Math.round((count / total) * 100)) : 0
              return (
                <div key={step.key}>
                  <div className="mb-1 flex items-center justify-between text-[13px]">
                    <span className="text-foreground">{step.label}</span>
                    <span className="tabular-nums text-foreground/70">
                      <strong className="text-ink">{count}</strong> · {pctOf(count, total)} of all
                      {i > 0 && (
                        <span className="text-foreground/50"> · {pctOf(count, prev)} step</span>
                      )}
                    </span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-ink transition-all"
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>

          {stats.stages.purchased > 0 && (
            <div className="rounded-md border border-border bg-card p-5">
              <p className="eyebrow mb-3 text-foreground/65">Purchases by tier</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(stats.byTier).map(([tier, n]) => (
                  <Badge key={tier} variant="outline" className="rounded-full border-ink/20 text-ink">
                    {tier}: {n}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** PostHog session link (distinct/session id + replay). Shown on BOTH /polaris
 *  and /techadmin so any admin can jump to a tester's session recording. */
function PostHogSessionBlock({
  r,
}: {
  r: { ph_session_id?: string; ph_distinct_id?: string }
}) {
  const replay = posthogReplayUrl(r.ph_session_id)
  return (
    <div>
      <label className="mb-2 block eyebrow text-foreground/65">PostHog session</label>
      {r.ph_session_id || r.ph_distinct_id ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {r.ph_distinct_id && <CopyChip label="distinct_id" value={r.ph_distinct_id} />}
            {r.ph_session_id && <CopyChip label="session_id" value={r.ph_session_id} />}
          </div>
          {replay && (
            <a
              href={replay}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-xs text-ink hover:underline"
            >
              Open recording in PostHog →
            </a>
          )}
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground">
          No PostHog session captured (tester predates telemetry, or PostHog is
          disabled in this environment).
        </p>
      )}
    </div>
  )
}

/** Per-response Source / Session block: first-touch attribution (utm_* /
 *  referrer / landing page) + PostHog session link. Shown on BOTH consoles. */
function ResponseSourceDetails({
  r,
}: {
  r: {
    ph_session_id?: string
    ph_distinct_id?: string
    utm_source?: string
    utm_medium?: string
    utm_campaign?: string
    utm_term?: string
    utm_content?: string
    fbclid?: string
    gclid?: string
    ttclid?: string
    msclkid?: string
    ref?: string
    lp?: string
    referrer?: string
    landing_page?: string
  }
}) {
  const utmRows: Array<{ label: string; value?: string }> = [
    { label: "Source", value: r.utm_source },
    { label: "Medium", value: r.utm_medium },
    { label: "Campaign", value: r.utm_campaign },
    { label: "Term", value: r.utm_term },
    { label: "Content", value: r.utm_content },
    { label: "Funnel", value: r.lp },
  ].filter((row) => cellFilled(row.value))

  // Ad-platform click IDs — presence identifies the platform that drove the click.
  const clickIds: Array<{ label: string; value?: string }> = [
    { label: "Meta", value: r.fbclid },
    { label: "Google", value: r.gclid },
    { label: "TikTok", value: r.ttclid },
    { label: "Microsoft", value: r.msclkid },
  ].filter((c) => cellFilled(c.value))

  const hasAttribution =
    utmRows.length > 0 ||
    clickIds.length > 0 ||
    cellFilled(r.ref) ||
    cellFilled(r.referrer) ||
    cellFilled(r.landing_page)

  return (
    <>
      <Separator />
      <p className="eyebrow border-b border-border pb-1.5 text-foreground/65">
        Source / Session
      </p>

      <div>
        <label className="mb-2 block eyebrow text-foreground/65">
          Referral / UTM
        </label>
        {hasAttribution ? (
          <div className="flex flex-col gap-2">
            {utmRows.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {utmRows.map((row) => (
                  <Badge
                    key={row.label}
                    variant="outline"
                    className="rounded-full border-ink/20 font-normal text-foreground/85"
                  >
                    <span className="text-foreground/50">{row.label}:</span>&nbsp;
                    {row.value}
                  </Badge>
                ))}
              </div>
            )}
            {clickIds.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground/50 text-xs">Platform click:</span>
                {clickIds.map((c) => (
                  <Badge
                    key={c.label}
                    variant="outline"
                    className="rounded-full border-ink/20 font-normal text-foreground/85"
                  >
                    {c.label}
                  </Badge>
                ))}
              </div>
            )}
            {cellFilled(r.ref) && (
              <p className="break-all text-xs text-foreground/75">
                <span className="text-foreground/50">Lead ref:</span> {r.ref}
              </p>
            )}
            {cellFilled(r.referrer) && (
              <p className="break-all text-xs text-foreground/75">
                <span className="text-foreground/50">Referrer:</span>{" "}
                {isHttpUrl(r.referrer!) ? (
                  <a
                    href={r.referrer}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink hover:underline"
                  >
                    {r.referrer}
                  </a>
                ) : (
                  r.referrer
                )}
              </p>
            )}
            {cellFilled(r.landing_page) && (
              <p className="break-all text-xs text-foreground/60">
                <span className="text-foreground/50">Landing:</span> {r.landing_page}
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs italic text-muted-foreground">
            Direct / no referral captured (or tester predates attribution tracking).
          </p>
        )}
      </div>

      <PostHogSessionBlock r={r} />
    </>
  )
}

/** Per-response tech block: journey progress + purchase record (/techadmin). */
function ResponseTechDetails({
  r,
}: {
  r: {
    answered?: boolean[]
    beat5_output?: string
    score_json?: string
    report_json?: string
    summary_text?: string
    offer_viewed_at?: string
    paid_tier?: string
    paid_amount?: string
    paid_at?: string
  }
}) {
  const journey: Array<{ label: string; done: boolean }> = [
    { label: "Signed up", done: true },
    { label: "Q1", done: r.answered?.[0] === true },
    { label: "Q5", done: r.answered?.[4] === true },
    { label: "Reflections", done: cellFilled(r.beat5_output) },
    { label: "Score", done: cellFilled(r.score_json) },
    { label: "Report", done: cellFilled(r.report_json) },
    { label: "Summary", done: cellFilled(r.summary_text) },
    // The funnel's biggest drop-off sits between these two - showing them
    // separately makes "saw the price and left" visible instead of implied.
    { label: "Offer page", done: cellFilled(r.offer_viewed_at) },
    { label: "Purchased", done: cellFilled(r.paid_tier) },
  ]

  return (
    <>
      <Separator />
      <p className="eyebrow border-b border-border pb-1.5 text-foreground/65">
        Tech / Analytics
      </p>

      <div>
        <label className="mb-2 block eyebrow text-foreground/65">Journey</label>
        <div className="flex flex-wrap items-center gap-1.5">
          {journey.map((s, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                  s.done ? "bg-ink text-background" : "bg-secondary text-foreground/45"
                }`}
              >
                {s.label}
              </span>
              {i < journey.length - 1 && <span className="text-foreground/30">→</span>}
            </span>
          ))}
        </div>
      </div>

      {cellFilled(r.paid_tier) && (
        <div>
          <label className="mb-1 block eyebrow text-foreground/65">Purchase</label>
          <Badge variant="outline" className="rounded-full border-green-500/30 text-green-600">
            {r.paid_tier}
            {r.paid_amount ? ` · $${r.paid_amount}` : ""}
            {r.paid_at ? ` · ${new Date(r.paid_at).toLocaleString()}` : ""}
          </Badge>
        </div>
      )}
    </>
  )
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(false)
  const [password, setPassword] = useState("")
  const [authError, setAuthError] = useState("")

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [saveLabel, setSaveLabel] = useState("Save Changes")
  const [saveDisabled, setSaveDisabled] = useState(false)
  const [copiedTag, setCopiedTag] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)

  const [audience, setAudience] = useState<Audience>("main")
  // User responses is the default landing tab - it's what the team opens the
  // console for day to day (the prompt editors are occasional-use). The
  // responses loader auto-fires for this tab, so data is on screen at login.
  const [tab, setTab] = useState<"system" | "entry" | "questions" | "beats" | "score" | "report" | "summary" | "responses" | "analytics">("responses")
  // The same console powers /polaris and /techadmin. On /techadmin we unlock the
  // Analytics tab + per-user telemetry (PostHog session, purchase, journey).
  const pathname = usePathname()
  const isTech = (pathname ?? "").startsWith("/techadmin")

  // Keep PostHog off inside the admin consoles, even when reached via client-
  // side navigation (the init check only sees the boot URL). On an admin route
  // we STOP session replay (stopSessionRecording tears down the active rrweb
  // recorder — the init `urlBlocklist` option is ignored client-side) and opt
  // out of event capture; on unmount (team navigates back to a customer page)
  // we resume both.
  useEffect(() => {
    const onAdmin =
      (pathname ?? "").startsWith("/polaris") ||
      (pathname ?? "").startsWith("/techadmin")
    if (!onAdmin) return
    try {
      posthog.stopSessionRecording()
      posthog.opt_out_capturing()
    } catch {
      /* posthog not initialized (e.g. dev without token) — nothing to do */
    }
    return () => {
      try {
        posthog.opt_in_capturing()
        posthog.startSessionRecording()
      } catch {
        /* noop */
      }
    }
  }, [pathname])

  // Per-vertical editor state. Every vertical persists in memory so
  // switching between tabs doesn't lose unsaved work.
  const [data, setData] = useState<Record<Audience, AudienceData>>(emptyAllVerticals)

  const [openCards, setOpenCards] = useState<Record<string, boolean>>({})

  // Responses tab state
  type UserResponse = {
    id: string
    firstName: string
    email: string
    phone?: string
    /** Vertical id at signup; older rows hold legacy "individual"/"team". */
    audience?: string
    createdAt: string
    /** Set once a lead re-signs up; createdAt then reflects the latest. */
    firstSignupAt?: string
    signupCount?: number
    // Raw answers are private and never sent by the API - only whether each
    // question was answered (index 0 = Q1). See lib/server/admin-user-view.ts.
    answered?: boolean[]
    question1_text?: string; question2_text?: string; question3_text?: string; question4_text?: string; question5_text?: string
    beat1_feedback: string; beat2_feedback: string; beat3_feedback: string; beat4_feedback: string; beat5_feedback: string
    beat1_output: string; beat2_output: string; beat3_output: string; beat4_output: string; beat5_output: string
    // Final outputs persisted at generation time (optional - older docs lack them).
    score_json?: string; report_json?: string; summary_text?: string; summary_audio_url?: string
    offer_viewed_at?: string
    // Tech-analytics telemetry + purchase (/techadmin only).
    ph_session_id?: string; ph_distinct_id?: string
    paid_tier?: string; paid_amount?: string; paid_at?: string
    // First-touch acquisition attribution (shown on both /polaris and /techadmin).
    utm_source?: string; utm_medium?: string; utm_campaign?: string
    utm_term?: string; utm_content?: string
    fbclid?: string; gclid?: string; ttclid?: string; msclkid?: string
    ref?: string; lp?: string; vertical?: string
    referrer?: string; landing_page?: string
  }
  const [responses, setResponses] = useState<UserResponse[]>([])
  const [responsesLoading, setResponsesLoading] = useState(false)
  const [responsesError, setResponsesError] = useState("")
  const [responsesOffset, setResponsesOffset] = useState(0)
  const [responsesHasMore, setResponsesHasMore] = useState(false)
  const [expandedResponses, setExpandedResponses] = useState<Record<string, boolean>>({})
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({})
  const didLoadResponses = useRef(false)

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState("")
  const [searchDateFrom, setSearchDateFrom] = useState("")
  const [searchDateTo, setSearchDateTo] = useState("")
  const [searchCompleted, setSearchCompleted] = useState<"all" | "true" | "false">("all")
  const [searchPurchased, setSearchPurchased] = useState<"all" | "true" | "false">("all")
  const [isSearchActive, setIsSearchActive] = useState(false)
  const [searchResults, setSearchResults] = useState<UserResponse[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState("")
  const [showFilters, setShowFilters] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Report preview modal (renders a persisted report_json via the shared
  // ReportView and exports the same PDF the user got).
  const [reportModal, setReportModal] = useState<
    { id: string; name: string; dateISO: string; data: ReportApiResponse; vertical: Vertical } | null
  >(null)
  const [reportPdfBusy, setReportPdfBusy] = useState(false)
  const reportModalRef = useRef<HTMLDivElement>(null)

  const didAutoLoad = useRef(false)
  const current = data[audience]

  /**
   * Read raw Cosmos prompt map and unpack EVERY vertical into editor state.
   * Keys are suffixed `_<vertical>`. Main additionally falls back to the
   * legacy `_individual` keys so the console shows real content before the
   * one-time verticals migration script has run. Non-main verticals load
   * exactly what's stored — empty fields stay empty (= inherit Main at
   * runtime), never pre-filled with defaults that would freeze inheritance.
   */
  const unpackPrompts = useCallback((raw: Record<string, string>) => {
    const next = emptyAllVerticals()
    // Value for `base` under vertical `aud`; main reads legacy keys too.
    const rv = (base: string, aud: Audience): string =>
      aud === "main"
        ? raw[`${base}_main`] || raw[`${base}_individual`] || ""
        : raw[`${base}_${aud}`] || ""
    for (const aud of VERTICALS) {
      const isMain = aud === "main"
      next[aud].systemPrompt = rv("system_prompt", aud)
      next[aud].reportSystemPrompt =
        rv("report_system_prompt", aud) || (isMain ? DEFAULT_REPORT_SYSTEM_PROMPT : "")
      next[aud].reportUserPrompt =
        rv("report_user_prompt", aud) || (isMain ? DEFAULT_REPORT_USER_PROMPT : "")
      next[aud].scoreSystemPrompt =
        rv("score_system_prompt", aud) || (isMain ? DEFAULT_SCORE_SYSTEM_PROMPT : "")
      next[aud].scoreUserPrompt =
        rv("score_user_prompt", aud) || (isMain ? DEFAULT_SCORE_USER_PROMPT : "")
      next[aud].summarySystemPrompt =
        rv("summary_system_prompt", aud) || (isMain ? DEFAULT_SUMMARY_SYSTEM_PROMPT : "")
      next[aud].summaryUserPrompt =
        rv("summary_user_prompt", aud) || (isMain ? DEFAULT_SUMMARY_USER_PROMPT : "")
      const qRaw = rv("questions", aud)
      if (qRaw) {
        try {
          const parsed = JSON.parse(qRaw)
          if (Array.isArray(parsed)) next[aud].questions = parsed
        } catch {
          /* keep empty */
        }
      }
      next[aud].beats = EMPTY_BEATS.map((_, i) => ({
        label: rv(`beat${i + 1}_label`, aud),
        title: rv(`beat${i + 1}_title`, aud),
        subtitle: rv(`beat${i + 1}_subtitle`, aud),
        feedbackQuestion: rv(`beat${i + 1}_feedbackQuestion`, aud),
        systemContext: rv(`beat${i + 1}_systemContext`, aud),
        userPrompt: rv(`beat${i + 1}_prompt`, aud),
      }))
      const eRaw = rv("entry_content", aud)
      if (eRaw) {
        try {
          const p = JSON.parse(eRaw) as Partial<EntryContent>
          const draft = isMain ? { ...DEFAULT_ENTRY_CONTENT } : { ...EMPTY_ENTRY_DRAFT }
          next[aud].entryContent = {
            eyebrow: typeof p.eyebrow === "string" ? p.eyebrow : draft.eyebrow,
            headline: typeof p.headline === "string" ? p.headline : draft.headline,
            headlineAccent:
              typeof p.headlineAccent === "string" ? p.headlineAccent : draft.headlineAccent,
            subcopy: typeof p.subcopy === "string" ? p.subcopy : draft.subcopy,
            ctaLabel: typeof p.ctaLabel === "string" ? p.ctaLabel : draft.ctaLabel,
            showVideo: typeof p.showVideo === "boolean" ? p.showVideo : draft.showVideo,
          }
        } catch {
          /* keep the empty/default draft */
        }
      }
    }
    setData(next)
  }, [])

  const loadPrompts = useCallback(async () => {
    setLoading(true)
    setLoadError("")
    try {
      const res = await fetch("/api/admin/prompts")
      if (res.status === 401) {
        setAuthed(false)
        setLoadError("Session expired. Please log in again.")
        return
      }
      if (!res.ok) throw new Error("HTTP " + res.status)
      const json = await res.json()
      if (json.ok && json.data) {
        unpackPrompts(json.data as Record<string, string>)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLoadError(`Failed to load prompts: ${msg}. Fields are empty - configure prompts manually.`)
    } finally {
      setLoading(false)
    }
  }, [unpackPrompts])

  const loadResponses = useCallback(async (offset = 0) => {
    setResponsesLoading(true)
    setResponsesError("")
    try {
      const params = new URLSearchParams({ pageSize: "25", offset: String(offset) })
      const res = await fetch(`/api/admin/responses?${params}`)
      if (res.status === 401) {
        setAuthed(false)
        throw new Error("Session expired. Please log in again.")
      }
      if (res.status === 401) throw new Error("Unauthorized")
      if (!res.ok) throw new Error("HTTP " + res.status)
      const json = await res.json()
      if (json.ok) {
        setResponses((prev) => (offset > 0 ? [...prev, ...json.users] : json.users))
        setResponsesOffset(
          typeof json.nextOffset === "number" ? json.nextOffset : offset + json.users.length
        )
        setResponsesHasMore(!!json.hasMore)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setResponsesError(`Failed to load responses: ${msg}`)
    } finally {
      setResponsesLoading(false)
    }
  }, [])

  const handleSearch = useCallback(async () => {
    setSearchLoading(true)
    setSearchError("")
    try {
      const params = new URLSearchParams()
      if (searchQuery.trim()) params.set("q", searchQuery.trim())
      if (searchDateFrom) params.set("dateFrom", searchDateFrom)
      if (searchDateTo) params.set("dateTo", searchDateTo)
      if (searchCompleted !== "all") params.set("completed", searchCompleted)
      if (searchPurchased !== "all") params.set("purchased", searchPurchased)
      const res = await fetch(`/api/admin/responses/search?${params}`)
      if (res.status === 401) {
        setAuthed(false)
        throw new Error("Session expired. Please log in again.")
      }
      if (res.status === 401) throw new Error("Unauthorized")
      if (!res.ok) throw new Error("HTTP " + res.status)
      const json = await res.json()
      if (json.ok) {
        setSearchResults(json.users)
        setIsSearchActive(true)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSearchError(`Search failed: ${msg}`)
    } finally {
      setSearchLoading(false)
    }
  }, [searchQuery, searchDateFrom, searchDateTo, searchCompleted, searchPurchased])

  const clearSearch = () => {
    setSearchQuery("")
    setSearchDateFrom("")
    setSearchDateTo("")
    setSearchCompleted("all")
    setSearchPurchased("all")
    setIsSearchActive(false)
    setSearchResults([])
    setSearchError("")
    setSelectedIds(new Set())
  }

  const toggleSelectId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    const displayed = isSearchActive ? searchResults : responses
    if (selectedIds.size === displayed.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(displayed.map((r) => r.id)))
    }
  }

  const downloadResponses = (items: UserResponse[]) => {
    const clean = items.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      email: r.email,
      phone: r.phone ?? "",
      audience: r.audience ?? "",
      createdAt: r.createdAt,
      answered: r.answered ?? [],
      question1_text: r.question1_text ?? "",
      question2_text: r.question2_text ?? "",
      question3_text: r.question3_text ?? "",
      question4_text: r.question4_text ?? "",
      question5_text: r.question5_text ?? "",
      beat1_feedback: r.beat1_feedback, beat2_feedback: r.beat2_feedback,
      beat3_feedback: r.beat3_feedback, beat4_feedback: r.beat4_feedback, beat5_feedback: r.beat5_feedback,
      beat1_output: r.beat1_output, beat2_output: r.beat2_output, beat3_output: r.beat3_output,
      beat4_output: r.beat4_output, beat5_output: r.beat5_output,
      score_json: r.score_json ?? "", report_json: r.report_json ?? "",
      summary_text: r.summary_text ?? "", summary_audio_url: r.summary_audio_url ?? "",
      // First-touch acquisition attribution.
      utm_source: r.utm_source ?? "", utm_medium: r.utm_medium ?? "",
      utm_campaign: r.utm_campaign ?? "", utm_term: r.utm_term ?? "",
      utm_content: r.utm_content ?? "",
      fbclid: r.fbclid ?? "", gclid: r.gclid ?? "", ttclid: r.ttclid ?? "",
      msclkid: r.msclkid ?? "", ref: r.ref ?? "", lp: r.lp ?? "",
      vertical: r.vertical ?? "",
      referrer: r.referrer ?? "",
      landing_page: r.landing_page ?? "",
    }))
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `ufa-responses-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const downloadSelected = () => {
    const displayed = isSearchActive ? searchResults : responses
    const items = displayed.filter((r) => selectedIds.has(r.id))
    if (items.length === 0) return
    downloadResponses(items)
  }

  const downloadAll = () => {
    const displayed = isSearchActive ? searchResults : responses
    if (displayed.length === 0) return
    downloadResponses(displayed)
  }

  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())

  /**
   * Permanently delete response rows. Irreversible, so it always confirms
   * first and names exactly what is going - and offers a CSV backup, since
   * an accidental delete of a real lead is otherwise unrecoverable.
   */
  const deleteResponses = async (rows: UserResponse[]) => {
    if (rows.length === 0) return
    const label =
      rows.length === 1
        ? `response #${rows[0].id} (${rows[0].email || "no email"})`
        : `${rows.length} responses`
    const completed = rows.filter((r) => r.answered?.[4] === true).length
    if (
      !window.confirm(
        `Permanently delete ${label}?\n\n` +
          (completed > 0
            ? `${completed} of these completed the assessment - their answers, beat outputs, score and report will be destroyed.\n\n`
            : "") +
          "This cannot be undone.\n\nTip: Cancel and use Download first if you want a CSV backup.",
      )
    ) {
      return
    }

    const ids = rows.map((r) => r.id)
    setDeletingIds((prev) => new Set([...prev, ...ids]))
    try {
      const res = await fetch("/api/admin/responses", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
      if (res.status === 401) {
        setAuthed(false)
        alert("Session expired. Please log in again.")
        return
      }
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      const removed: string[] = json.deleted ?? []
      const gone = new Set([...removed, ...(json.missing ?? [])])
      // Drop them from both lists so the UI matches the database without a
      // full refetch (which would reset pagination).
      setResponses((prev) => prev.filter((r) => !gone.has(r.id)))
      setSearchResults((prev) => prev.filter((r) => !gone.has(r.id)))
      setSelectedIds((prev) => {
        const next = new Set(prev)
        gone.forEach((id) => next.delete(id))
        return next
      })
      if (json.failed?.length) {
        alert(`Deleted ${removed.length}. Failed to delete: ${json.failed.join(", ")}`)
      }
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
    }
  }

  const deleteSelected = () => {
    const displayed = isSearchActive ? searchResults : responses
    void deleteResponses(displayed.filter((r) => selectedIds.has(r.id)))
  }

  const [loggingIn, setLoggingIn] = useState(false)

  const checkSession = useCallback(async (): Promise<boolean> => {
    try {
      const scope = isTech ? "tech" : "admin"
      const res = await fetch(`/api/admin/auth-check?scope=${scope}`)
      return res.ok
    } catch {
      return false
    }
  }, [isTech])

  const login = useCallback(
    async (pw: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const scope = isTech ? "tech" : "admin"
        const res = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pw, scope }),
        })
        const json = await res.json().catch(() => null)
        if (!res.ok || !json?.ok) {
          return { ok: false, error: json?.error || "Invalid password." }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Login failed" }
      }
    },
    [isTech],
  )

  useEffect(() => {
    if (typeof window === "undefined") return
    const stored = localStorage.getItem("admin-last-saved-at")
    if (stored) setLastSavedAt(stored)
  }, [])

  useEffect(() => {
    if (didAutoLoad.current) return
    didAutoLoad.current = true
    if (typeof window === "undefined") return
    try {
      sessionStorage.removeItem("admin-api-password")
    } catch {
      /* ignore */
    }
    void checkSession().then((valid) => {
      if (valid) {
        setAuthed(true)
        void loadPrompts()
      }
    })
  }, [checkSession, loadPrompts])

  useEffect(() => {
    if (tab === "responses" && authed && !didLoadResponses.current) {
      didLoadResponses.current = true
      void loadResponses()
    }
  }, [tab, authed, loadResponses])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError("")
    setLoggingIn(true)
    try {
      const res = await login(password)
      if (!res.ok) {
        setAuthError(res.error || "Invalid password.")
        return
      }
      setPassword("")
      setAuthed(true)
      void loadPrompts()
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = async () => {
    try {
      await fetch("/api/admin/logout", { method: "POST" })
    } catch {
      /* ignore */
    }
    setAuthed(false)
    setPassword("")
    try {
      sessionStorage.removeItem("admin-api-password")
    } catch {
      /* ignore */
    }
  }

  /**
   * Save EVERY vertical in a single round-trip - keeps the API simple and
   * the editor consistent. Each key is suffixed with the vertical id.
   * Empty values are written as-is: an empty key on a non-main vertical
   * means "inherit Main" to the runtime resolver.
   */
  const handleSave = async () => {
    setSaveDisabled(true)
    setSaveLabel("Saving...")
    const payload: Record<string, string> = {}
    for (const aud of VERTICALS) {
      const ad = data[aud]
      payload[`system_prompt_${aud}`] = ad.systemPrompt
      payload[`report_system_prompt_${aud}`] = ad.reportSystemPrompt
      payload[`report_user_prompt_${aud}`] = ad.reportUserPrompt
      payload[`score_system_prompt_${aud}`] = ad.scoreSystemPrompt
      payload[`score_user_prompt_${aud}`] = ad.scoreUserPrompt
      payload[`summary_system_prompt_${aud}`] = ad.summarySystemPrompt
      payload[`summary_user_prompt_${aud}`] = ad.summaryUserPrompt
      payload[`questions_${aud}`] = JSON.stringify(ad.questions)
      payload[`entry_content_${aud}`] = JSON.stringify(ad.entryContent)
      ad.beats.forEach((b, i) => {
        payload[`beat${i + 1}_prompt_${aud}`] = b.userPrompt
        payload[`beat${i + 1}_label_${aud}`] = b.label
        payload[`beat${i + 1}_title_${aud}`] = b.title
        payload[`beat${i + 1}_subtitle_${aud}`] = b.subtitle
        payload[`beat${i + 1}_feedbackQuestion_${aud}`] = b.feedbackQuestion
        payload[`beat${i + 1}_systemContext_${aud}`] = b.systemContext
      })
    }
    try {
      const res = await fetch("/api/admin/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: payload }),
      })
      if (res.status === 401) {
        setAuthed(false)
        alert("Session expired. Please log in again.")
        setSaveLabel("Save Changes")
        return
      }
      if (!res.ok) {
        // Surface the actual server error so failures are diagnosable.
        // The old "HTTP 5xx" wording hid the upstream Cosmos error string.
        let detail = ""
        try {
          const body = await res.text()
          if (body) detail = body.slice(0, 400)
        } catch {
          /* ignore */
        }
        throw new Error(`HTTP ${res.status}${detail ? ` - ${detail}` : ""}`)
      }
      const savedIso = new Date().toISOString()
      setLastSavedAt(savedIso)
      try {
        localStorage.setItem("admin-last-saved-at", savedIso)
      } catch {
        /* quota */
      }
      setSaveLabel("Saved!")
      setTimeout(() => setSaveLabel("Save Changes"), 2000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert("Failed to save: " + msg)
      setSaveLabel("Save Changes")
    } finally {
      setSaveDisabled(false)
    }
  }

  const importFileRef = useRef<HTMLInputElement>(null)

  const isQuestionShape = (v: unknown): v is Question => {
    if (!v || typeof v !== "object") return false
    const o = v as Record<string, unknown>
    return (
      typeof o.stageFraming === "string" &&
      typeof o.question === "string" &&
      typeof o.prompt === "string" &&
      typeof o.hintBox === "string" &&
      typeof o.placeholder === "string" &&
      typeof o.quoteZone === "string"
    )
  }

  const isBeatShape = (v: unknown): v is Beat => {
    if (!v || typeof v !== "object") return false
    const o = v as Record<string, unknown>
    return (
      typeof o.label === "string" &&
      typeof o.systemContext === "string" &&
      typeof o.userPrompt === "string" &&
      (o.title === undefined || typeof o.title === "string") &&
      (o.subtitle === undefined || typeof o.subtitle === "string")
    )
  }

  /**
   * Imports JSON config into the CURRENT audience tab only - never overwrites
   * the other audience. This is intentional: admins seed each audience
   * separately so accidental cross-pollination is impossible.
   */
  const handleImportConfig = async (file: File) => {
    try {
      if (file.size > 2 * 1024 * 1024) {
        alert("File too large (max 2 MB). Is this the right file?")
        return
      }
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        alert("Invalid JSON file - could not parse.")
        return
      }
      if (!parsed || typeof parsed !== "object") {
        alert("Invalid config file - expected a JSON object.")
        return
      }
      const obj = parsed as Record<string, unknown>

      if (typeof obj.systemPrompt !== "string") {
        alert("Invalid config: missing or non-string 'systemPrompt'.")
        return
      }
      if (!Array.isArray(obj.questions) || obj.questions.length !== 5 || !obj.questions.every(isQuestionShape)) {
        alert("Invalid config: 'questions' must be an array of exactly 5 question objects.")
        return
      }
      if (!Array.isArray(obj.beats) || obj.beats.length !== 5 || !obj.beats.every(isBeatShape)) {
        alert("Invalid config: 'beats' must be an array of exactly 5 beat objects.")
        return
      }

      const exportedAtRaw = typeof obj.exportedAt === "string" ? obj.exportedAt : ""
      let exportedAtLabel = ""
      if (exportedAtRaw) {
        try {
          exportedAtLabel = new Date(exportedAtRaw).toLocaleString()
        } catch { exportedAtLabel = exportedAtRaw }
      }

      const confirmed = window.confirm(
        `This will replace all prompts (AI persona, Score, PDF report, Closing summary), the 5 Questions, and the 5 Beats for the ${audience.toUpperCase()} audience only.\n\n` +
        (exportedAtLabel ? `Backup export timestamp: ${exportedAtLabel}\n\n` : "") +
        `A backup of the current ${audience} editor state will be downloaded first.\n\n` +
        `Nothing is saved to the database until you click Save Changes.\n\nProceed?`
      )
      if (!confirmed) return

      try { handleDownloadConfig() } catch { /* download failures shouldn't block */ }

      const newQuestions = obj.questions as Question[]
      const newBeats = (obj.beats as Record<string, string>[]).map((b) => ({
        label: b.label ?? "",
        title: b.title ?? "",
        subtitle: b.subtitle ?? "",
        feedbackQuestion: b.feedbackQuestion ?? "",
        systemContext: b.systemContext ?? "",
        userPrompt: b.userPrompt ?? "",
      }))

      // Keep a field if the imported config omits it (older v2 backups only
      // carried systemPrompt/reportSystemPrompt). Spreading prev[audience]
      // first guarantees no field is ever dropped to undefined.
      const keep = (v: unknown, fallback: string) =>
        typeof v === "string" ? v : fallback

      setData((prev) => ({
        ...prev,
        [audience]: {
          ...prev[audience],
          systemPrompt: obj.systemPrompt as string,
          reportSystemPrompt: keep(obj.reportSystemPrompt, prev[audience].reportSystemPrompt),
          reportUserPrompt: keep(obj.reportUserPrompt, prev[audience].reportUserPrompt),
          scoreSystemPrompt: keep(obj.scoreSystemPrompt, prev[audience].scoreSystemPrompt),
          scoreUserPrompt: keep(obj.scoreUserPrompt, prev[audience].scoreUserPrompt),
          summarySystemPrompt: keep(obj.summarySystemPrompt, prev[audience].summarySystemPrompt),
          summaryUserPrompt: keep(obj.summaryUserPrompt, prev[audience].summaryUserPrompt),
          questions: newQuestions,
          beats: newBeats,
          entryContent:
            obj.entryContent && typeof obj.entryContent === "object"
              ? { ...prev[audience].entryContent, ...(obj.entryContent as Partial<EntryContent>) }
              : prev[audience].entryContent,
        },
      }))
      alert(`Config imported into the ${audience} editor. Click Save Changes to persist.`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert("Failed to import: " + msg)
    }
  }

  const handleDownloadConfig = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 3,
      audience,
      systemPrompt: current.systemPrompt,
      // Every editable prompt - keep this list in sync with AudienceData and
      // handleSave so a config backup captures the full editor state. Older
      // (v2) exports omitted the score/summary/user prompts; import below
      // tolerates their absence.
      reportSystemPrompt: current.reportSystemPrompt,
      reportUserPrompt: current.reportUserPrompt,
      scoreSystemPrompt: current.scoreSystemPrompt,
      scoreUserPrompt: current.scoreUserPrompt,
      summarySystemPrompt: current.summarySystemPrompt,
      summaryUserPrompt: current.summaryUserPrompt,
      questions: current.questions,
      beats: current.beats,
      entryContent: current.entryContent,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    a.href = url
    a.download = `ufa-config-${audience}-${stamp}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const copyTag = (tag: string) => {
    navigator.clipboard.writeText(tag).catch(() => {})
    setCopiedTag(tag)
    setTimeout(() => setCopiedTag(null), 1500)
  }

  const updateSystemPrompt = (value: string) =>
    setData((prev) => ({ ...prev, [audience]: { ...prev[audience], systemPrompt: value } }))

  const updateReportSystemPrompt = (value: string) =>
    setData((prev) => ({ ...prev, [audience]: { ...prev[audience], reportSystemPrompt: value } }))

  const updateScoreSystemPrompt = (value: string) =>
    setData((prev) => ({ ...prev, [audience]: { ...prev[audience], scoreSystemPrompt: value } }))

  const updateSummarySystemPrompt = (value: string) =>
    setData((prev) => ({ ...prev, [audience]: { ...prev[audience], summarySystemPrompt: value } }))

  const updateReportUserPrompt = (value: string) =>
    setData((prev) => ({ ...prev, [audience]: { ...prev[audience], reportUserPrompt: value } }))

  const updateScoreUserPrompt = (value: string) =>
    setData((prev) => ({ ...prev, [audience]: { ...prev[audience], scoreUserPrompt: value } }))

  const updateSummaryUserPrompt = (value: string) =>
    setData((prev) => ({ ...prev, [audience]: { ...prev[audience], summaryUserPrompt: value } }))

  const updateEntryContent = <K extends keyof EntryContent>(key: K, value: EntryContent[K]) =>
    setData((prev) => ({
      ...prev,
      [audience]: {
        ...prev[audience],
        entryContent: { ...prev[audience].entryContent, [key]: value },
      },
    }))

  /**
   * Copy Main's full editor state into the current vertical tab as a
   * starting point. Nothing is persisted until Save Changes - and note the
   * trade-off: seeded fields become overrides, so later Main edits no
   * longer flow through to them. Prefer editing only what differs.
   */
  const handleSeedFromMain = () => {
    if (audience === "main") return
    const confirmed = window.confirm(
      `Copy the MAIN editor state into the ${VERTICAL_LABELS[audience].toUpperCase()} tab?\n\n` +
      `This replaces everything currently in this tab (unsaved edits included). ` +
      `Seeded fields become overrides - future Main edits will NOT flow through to them.\n\n` +
      `Nothing is saved to the database until you click Save Changes.`
    )
    if (!confirmed) return
    setData((prev) => ({ ...prev, [audience]: structuredClone(prev.main) }))
  }

  const updateQuestion = <K extends keyof Question>(idx: number, key: K, value: Question[K]) => {
    setData((prev) => ({
      ...prev,
      [audience]: {
        ...prev[audience],
        questions: prev[audience].questions.map((q, i) => (i === idx ? { ...q, [key]: value } : q)),
      },
    }))
  }

  const updateBeat = <K extends keyof Beat>(idx: number, key: K, value: Beat[K]) => {
    setData((prev) => ({
      ...prev,
      [audience]: {
        ...prev[audience],
        beats: prev[audience].beats.map((b, i) => (i === idx ? { ...b, [key]: value } : b)),
      },
    }))
  }

  const toggleCard = (id: string) => {
    setOpenCards((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const toggleResponse = (id: string) => {
    setExpandedResponses((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const toggleOutput = (key: string) => {
    setExpandedOutputs((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const formatDate = (iso: string) => {
    if (!iso) return "-"
    try {
      return new Date(iso).toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    } catch { return iso }
  }

  // Editorial tab styling - every active state collapses to ink/background
  // so the admin chrome reads as one calm family, not four neon tags.
  const tabConfig = [
    { value: "system" as const, label: "AI persona", activeClass: "bg-ink text-background" },
    { value: "entry" as const, label: "Entry page", activeClass: "bg-ink text-background" },
    { value: "questions" as const, label: "The 5 questions", activeClass: "bg-ink text-background" },
    { value: "beats" as const, label: "Reflections (beats 1–5)", activeClass: "bg-ink text-background" },
    { value: "score" as const, label: "Score (0–100)", activeClass: "bg-ink text-background" },
    { value: "report" as const, label: "PDF report", activeClass: "bg-ink text-background" },
    { value: "summary" as const, label: "Closing summary", activeClass: "bg-ink text-background" },
    { value: "responses" as const, label: "User responses", activeClass: "bg-ink text-background" },
    ...(isTech
      ? [{ value: "analytics" as const, label: "Analytics", activeClass: "bg-ink text-background" }]
      : []),
  ]

  // ── Login Screen ──
  if (!authed) {
    return (
      <div
        data-palette="marine"
        className="flex min-h-screen items-center justify-center bg-background px-5 font-sans"
      >
        <form
          className="w-full max-w-sm rounded-md s-card-static p-8 animate-fade-in-up"
          onSubmit={handleLogin}
        >
          <div className="mb-7 flex flex-col items-center">
            <span className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-secondary text-ink">
              <Lock className="h-4 w-4" strokeWidth={1.5} />
            </span>
            <p className="eyebrow mb-3 text-foreground/65">
              <span className="pulse-dot mr-2.5" aria-hidden />
              Admin
            </p>
            <h2 className="font-serif text-[24px] leading-snug text-ink">
              Admin
              <span className="font-serif-italic text-foreground"> access.</span>
            </h2>
            <p className="mt-2 text-center font-serif-italic text-[14px] leading-snug text-foreground/75">
              Enter the admin password to manage prompts.
            </p>
          </div>

          <label className="mb-4 block">
            <span className="eyebrow mb-2 block text-foreground/65">
              Password
            </span>
            <Input
              type="password"
              id="api-password"
              placeholder="Leave empty if none set"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="s-input h-11"
            />
          </label>

          {authError && (
            <p
              role="alert"
              className="mb-4 font-serif-italic text-[14px] leading-snug text-foreground/85"
            >
              {authError}
            </p>
          )}

          <button
            type="submit"
            disabled={loggingIn}
            className="s-btn group h-11 w-full justify-center disabled:opacity-50"
          >
            {loggingIn ? "Connecting..." : "Connect"}
          </button>
        </form>
      </div>
    )
  }

  // ── Main Admin Panel ──
  // Both audience pills use the same ink-on-background treatment; the
  // text label tells the reader which is active. Audience-specific colour
  // coding got loud - calm wins on an internal tool.
  const audienceClass = "bg-ink text-background"

  return (
    <div data-palette="marine" className="min-h-screen bg-background font-sans">
      {/* Sticky Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-xl border-b-2 border-foreground/10">
        {/* Wraps instead of overflowing: at phone width the actions drop to
            a second row rather than drawing over the title. */}
        <div className="max-w-5xl mx-auto px-5 min-h-16 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="brand-mark brand-mark-sm" aria-hidden />
            <div className="flex flex-col">
              <h1 className="font-serif text-[18px] leading-tight text-ink">Prompt admin</h1>
              <span className="text-[10px] uppercase tracking-[0.22em] tabular-nums text-foreground/55">
                {lastSavedAt ? `Last saved · ${formatDate(lastSavedAt)}` : "Not yet saved"}
              </span>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleImportConfig(file)
                e.target.value = ""
              }}
            />
            <button
              type="button"
              onClick={() => importFileRef.current?.click()}
              disabled={loading}
              title={`Upload JSON into the ${audience} editor`}
              aria-label={`Import ${audience}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-foreground/35 px-3 text-[10px] uppercase tracking-[0.22em] text-foreground transition-colors duration-300 hover:border-ink hover:text-ink disabled:opacity-50 sm:px-4"
            >
              <Upload className="h-3 w-3" strokeWidth={1.6} />
              <span className="hidden sm:inline">Import {audience}</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadConfig}
              disabled={loading}
              title={`Download the ${audience} editor state as JSON`}
              aria-label={`Export ${audience}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-foreground/35 px-3 text-[10px] uppercase tracking-[0.22em] text-foreground transition-colors duration-300 hover:border-ink hover:text-ink disabled:opacity-50 sm:px-4"
            >
              <Download className="h-3 w-3" strokeWidth={1.6} />
              <span className="hidden sm:inline">Export {audience}</span>
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveDisabled}
              className="s-btn h-9 px-5"
            >
              <Save className="h-3 w-3" strokeWidth={1.6} />
              {saveLabel}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              title="Sign out of the admin console"
              aria-label="Sign out"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-foreground/35 px-3 text-[10px] uppercase tracking-[0.22em] text-foreground transition-colors duration-300 hover:border-ink hover:text-ink sm:px-4"
            >
              <LogOut className="h-3 w-3" strokeWidth={1.6} />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10">
        {/* Intro */}
        <div className="mb-7 animate-fade-in-up">
          <p className="eyebrow mb-3 flex items-center gap-3 text-foreground/65">
            <span className="h-px w-6 bg-foreground/40" aria-hidden />
            Your Belief Score · Prompt configuration
          </p>
          <h2 className="mb-3 font-serif text-[24px] leading-snug text-ink sm:text-[28px]">
            Edit content per
            <span className="font-serif-italic text-foreground"> vertical.</span>
          </h2>
          <p className="max-w-2xl text-[15px] leading-[1.8] text-foreground/85">
            <span className="font-serif text-ink">Main</span> is the base every
            other vertical inherits from - on the{" "}
            {VERTICALS.filter((v) => v !== "main")
              .map((v) => VERTICAL_LABELS[v])
              .join(", ")}{" "}
            tabs, any field left <em>empty</em> serves Main&apos;s content at
            runtime, so only override what differs.{" "}
            <span className="font-serif text-ink">Save changes</span> writes every
            vertical in a single round-trip.
          </p>
          {loadError && (
            <p
              role="alert"
              className="mt-3 font-serif-italic text-[14px] text-foreground/85"
            >
              {loadError}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="outline" className="rounded-full border-border px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-foreground/75">
              <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-foreground/40" />
              Cosmos DB
            </Badge>
            <Badge variant="outline" className="rounded-full border-border px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-foreground/75">
              <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-ink/60" />
              {current.questions.length} questions
            </Badge>
            <Badge variant="outline" className="rounded-full border-border px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-foreground/75">
              <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-ink/60" />
              {current.beats.length} beats
            </Badge>
          </div>
        </div>

        <div className="hairline mb-7" />

        {/* Vertical toggle - only for content tabs */}
        {tab !== "responses" && (
          <div className="mb-7 flex flex-wrap items-center gap-3">
            <span className="eyebrow text-foreground/65">Vertical</span>
            <div className="inline-flex flex-wrap rounded-full border border-border bg-card p-1">
              {VERTICALS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAudience(v)}
                  className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-[11px] uppercase tracking-[0.2em] transition-all duration-300 ${
                    audience === v
                      ? "bg-ink text-background"
                      : "text-foreground/65 hover:text-ink"
                  }`}
                >
                  {VERTICAL_LABELS[v]}
                </button>
              ))}
            </div>
            <span className={`rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.22em] ${audienceClass}`}>
              Editing · {VERTICAL_LABELS[audience]}
            </span>
            {audience !== "main" && (
              <button
                type="button"
                onClick={handleSeedFromMain}
                disabled={loading}
                title="Copy Main's editor state into this vertical as a starting point"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-foreground/35 px-3.5 text-[10px] uppercase tracking-[0.22em] text-foreground transition-colors duration-300 hover:border-ink hover:text-ink disabled:opacity-50"
              >
                Seed from Main
              </button>
            )}
          </div>
        )}

        {loading ? (
          // Skeleton mirrors the loaded chrome: the tab pill row + an editor
          // card, so the console doesn't reflow when prompts land.
          <div className="space-y-7">
            <div className="inline-flex flex-wrap gap-1.5 rounded-full border border-border bg-card p-1">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-24 rounded-full" />
              ))}
            </div>
            <div className="rounded-md border border-border bg-card p-5 space-y-3">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        ) : (
          <div className="animate-fade-in-up delay-100">
            {/* Tab Navigation - calm pill switcher */}
            <div className="mb-7 inline-flex flex-wrap gap-0.5 rounded-full border border-border bg-card p-1">
              {tabConfig.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTab(t.value)}
                  className={`rounded-full px-4 py-1.5 text-[11px] uppercase tracking-[0.2em] transition-all duration-300 ${
                    tab === t.value
                      ? t.activeClass
                      : "text-foreground/65 hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* ── Entry Page Tab ── */}
            {tab === "entry" && (
              <div className="space-y-4">
                <div className="rounded-md border border-border bg-secondary/40 p-4 text-[14px] leading-[1.7] text-foreground/85">
                  The static copy on the{" "}
                  <strong className="text-foreground">&quot;your details&quot; entry page</strong>{" "}
                  (/challenge/audience) shown to visitors arriving from the{" "}
                  <strong className="text-foreground">{VERTICAL_LABELS[audience]}</strong>{" "}
                  landing page{audience !== "main" ? ` (links with ?vertical=${audience})` : ""}.
                  Nothing here is AI-generated - this is deterministic, reviewed copy.
                  {audience !== "main" && (
                    <>
                      {" "}Fields left <em>empty</em> inherit Main&apos;s copy at runtime;
                      the greyed text shows what would currently be served.
                    </>
                  )}
                </div>

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6 space-y-5">
                    {(
                      [
                        { key: "eyebrow" as const, label: "Eyebrow (kicker above the headline)", rows: 0 },
                        { key: "headline" as const, label: "Headline - first line", rows: 0 },
                        { key: "headlineAccent" as const, label: "Headline - italic second line", rows: 0 },
                        { key: "subcopy" as const, label: "Subcopy paragraph", rows: 3 },
                        { key: "ctaLabel" as const, label: "CTA button label", rows: 0 },
                      ]
                    ).map((f) => {
                      // What runtime serves if this field stays empty on a
                      // non-main tab: Main's value, else the shipped default.
                      const inherited =
                        data.main.entryContent[f.key] || DEFAULT_ENTRY_CONTENT[f.key]
                      const placeholder =
                        audience === "main"
                          ? String(DEFAULT_ENTRY_CONTENT[f.key])
                          : `Inherits Main: ${inherited}`
                      return (
                        <label key={f.key} className="block">
                          <span className="eyebrow mb-2 block text-foreground/65">
                            {f.label}
                          </span>
                          {f.rows > 0 ? (
                            <Textarea
                              rows={f.rows}
                              value={current.entryContent[f.key]}
                              placeholder={placeholder}
                              onChange={(e) => updateEntryContent(f.key, e.target.value)}
                              className="s-input resize-y text-sm"
                            />
                          ) : (
                            <Input
                              type="text"
                              value={current.entryContent[f.key]}
                              placeholder={placeholder}
                              onChange={(e) => updateEntryContent(f.key, e.target.value)}
                              className="s-input h-11 text-sm"
                            />
                          )}
                        </label>
                      )
                    })}
                    <label className="flex items-center gap-2.5 pt-1">
                      <input
                        type="checkbox"
                        checked={current.entryContent.showVideo}
                        onChange={(e) => updateEntryContent("showVideo", e.target.checked)}
                        className="rounded border-foreground/30 accent-ink"
                      />
                      <span className="text-[14px] text-foreground/85">
                        Show the founder orientation video below the form
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* ── System Prompt Tab ── */}
            {tab === "system" && (
              <div className="space-y-4">
                <div className="rounded-md border border-border bg-secondary/40 p-4 text-[14px] leading-[1.7] text-foreground/85">
                  Editing the <strong className="text-foreground capitalize">{audience}</strong> system prompt. Sent
                  as the system message to the AI for every beat. Use placeholders:{" "}
                  <code className="px-1.5 py-0.5 rounded bg-card border border-border font-mono text-xs">{"{{NAME}}"}</code>,{" "}
                  <code className="px-1.5 py-0.5 rounded bg-card border border-border font-mono text-xs">{"{{Q1}}"}</code>-<code className="px-1.5 py-0.5 rounded bg-card border border-border font-mono text-xs">{"{{Q5}}"}</code>{" "}
                  which are replaced with user data at runtime.
                </div>

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6">
                    <div className="flex justify-between items-center mb-2">
                      <label className="eyebrow text-foreground/65">
                        System Prompt - {audience}
                      </label>
                      <span className="text-xs text-muted-foreground">
                        {current.systemPrompt.length} chars
                      </span>
                    </div>
                    <Textarea
                      rows={24}
                      value={current.systemPrompt}
                      onChange={(e) => updateSystemPrompt(e.target.value)}
                      className="min-h-[400px] font-mono text-sm s-input resize-y"
                    />
                    <div className="flex flex-wrap gap-2 mt-3">
                      {["{{NAME}}", "{{Q1}}", "{{Q2}}", "{{Q3}}", "{{Q4}}", "{{Q5}}"].map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => copyTag(t)}
                          className="inline-flex items-center gap-1 font-mono text-xs text-primary bg-secondary px-2.5 py-1 rounded-lg border border-primary/15 hover:bg-primary/10 hover:border-primary/25 transition-all duration-200 active:scale-95"
                        >
                          {copiedTag === t ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Questions Tab ── */}
            {tab === "questions" && (
              <div className="space-y-3">
                <div className="rounded-md border border-border bg-secondary/40 p-4 text-[14px] leading-[1.7] text-foreground/85">
                  Editing the <strong className="text-foreground capitalize">{audience}</strong> question copy. The
                  user sees these in order during the diagnostic.
                </div>
                {current.questions.map((q, i) => {
                  const id = `q${audience}${i}`
                  const open = !!openCards[id]
                  return (
                    <div key={id} className={`bg-card rounded-md overflow-hidden transition-all duration-300 ${open ? "s-card" : "s-card-static"}`}>
                      <button
                        type="button"
                        onClick={() => toggleCard(id)}
                        className="w-full flex items-center gap-3 p-4 text-left hover:bg-secondary/30 transition-colors duration-200"
                      >
                        <span className="w-8 h-8 rounded-full bg-secondary text-ink text-sm font-serif flex items-center justify-center shrink-0">
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="eyebrow text-foreground/70">{q.stageFraming || "-"}</p>
                          <p className="text-sm text-foreground truncate mt-0.5">{q.question.slice(0, 80) || "(empty)"}</p>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 mr-2">{wordCount(q.question + q.prompt)} words</span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
                      </button>

                      {open && (
                        <div className="border-t border-border/60 p-5 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                          <div className="grid sm:grid-cols-2 gap-4">
                            <div>
                              <label className="block eyebrow text-foreground/65 mb-1.5">Stage Framing</label>
                              <Input
                                value={q.stageFraming}
                                onChange={(e) => updateQuestion(i, "stageFraming", e.target.value)}
                                className="s-input"
                              />
                            </div>
                            <div>
                              <label className="block eyebrow text-foreground/65 mb-1.5">Placeholder</label>
                              <Input
                                value={q.placeholder}
                                onChange={(e) => updateQuestion(i, "placeholder", e.target.value)}
                                className="s-input"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block eyebrow text-foreground/65 mb-1.5">Question</label>
                            <Textarea rows={3} value={q.question} onChange={(e) => updateQuestion(i, "question", e.target.value)} className="s-input" />
                          </div>
                          <div>
                            <label className="block eyebrow text-foreground/65 mb-1.5">Prompt / Context</label>
                            <Textarea rows={5} value={q.prompt} onChange={(e) => updateQuestion(i, "prompt", e.target.value)} className="s-input" />
                          </div>
                          <div className="grid sm:grid-cols-2 gap-4">
                            <div>
                              <label className="block eyebrow text-foreground/65 mb-1.5">Hint Box</label>
                              <Textarea rows={2} value={q.hintBox} onChange={(e) => updateQuestion(i, "hintBox", e.target.value)} className="s-input" />
                            </div>
                            <div>
                              <label className="block eyebrow text-foreground/65 mb-1.5">Quote Zone</label>
                              <Textarea rows={2} value={q.quoteZone} onChange={(e) => updateQuestion(i, "quoteZone", e.target.value)} className="s-input" />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* ── Beats Tab ── */}
            {tab === "beats" && (
              <div className="space-y-3">
                <div className="rounded-md border border-border bg-secondary/40 p-4 text-[14px] leading-[1.7] text-foreground/85">
                  Editing the <strong className="text-foreground capitalize">{audience}</strong> beat prompts. The{" "}
                  <strong className="text-foreground">System Context</strong> sets the AI&apos;s role. The{" "}
                  <strong className="text-foreground">User Prompt</strong> is the instruction sent to the AI. Use{" "}
                  <code className="px-1.5 py-0.5 rounded bg-card border border-border font-mono text-xs">{"{{GATE2}}"}</code> and{" "}
                  <code className="px-1.5 py-0.5 rounded bg-card border border-border font-mono text-xs">{"{{GATE4}}"}</code> placeholders.
                </div>

                {current.beats.map((b, i) => {
                  const id = `b${audience}${i}`
                  const open = !!openCards[id]
                  return (
                    <div key={id} className={`bg-card rounded-md overflow-hidden transition-all duration-300 ${open ? "s-card" : "s-card-static"}`}>
                      <button
                        type="button"
                        onClick={() => toggleCard(id)}
                        className="w-full flex items-center gap-3 p-4 text-left hover:bg-secondary/30 transition-colors duration-200"
                      >
                        <span className="w-8 h-8 rounded-full bg-secondary text-ink text-sm font-serif flex items-center justify-center shrink-0">
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="eyebrow text-foreground/70">Beat {i + 1}</p>
                          <p className="text-sm text-foreground truncate mt-0.5">{b.label || "(empty)"}</p>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 mr-2">{wordCount(b.systemContext + b.userPrompt)} words</span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
                      </button>

                      {open && (
                        <div className="border-t border-border/60 p-5 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                          <div>
                            <label className="block eyebrow text-foreground/65 mb-1.5">Label</label>
                            <Input value={b.label} onChange={(e) => updateBeat(i, "label", e.target.value)} className="s-input" placeholder="e.g. What the mirror sees" />
                          </div>
                          <div className="grid sm:grid-cols-2 gap-4">
                            <div>
                              <label className="block eyebrow text-foreground/65 mb-1.5">Title</label>
                              <Textarea rows={2} value={b.title} onChange={(e) => updateBeat(i, "title", e.target.value)} className="s-input" placeholder="Heading shown on beat reveal page" />
                            </div>
                            <div>
                              <label className="block eyebrow text-foreground/65 mb-1.5">Subtitle</label>
                              <Textarea rows={2} value={b.subtitle} onChange={(e) => updateBeat(i, "subtitle", e.target.value)} className="s-input" placeholder="Subheading shown below the title" />
                            </div>
                          </div>
                          <div>
                            <label className="block eyebrow text-foreground/65 mb-1.5">Feedback Question</label>
                            <Input value={b.feedbackQuestion} onChange={(e) => updateBeat(i, "feedbackQuestion", e.target.value)} className="s-input" placeholder="e.g. Does this feel accurate to where you are right now?" />
                          </div>
                          <div>
                            <label className="block eyebrow text-foreground/65 mb-1.5">System Context</label>
                            <Textarea rows={4} value={b.systemContext} onChange={(e) => updateBeat(i, "systemContext", e.target.value)} className="font-mono text-sm s-input" />
                          </div>
                          <div>
                            <div className="flex justify-between items-center mb-1.5">
                              <label className="eyebrow text-foreground/65">User Prompt</label>
                              <span className="text-xs text-muted-foreground">{b.userPrompt.length} chars</span>
                            </div>
                            <Textarea rows={6} value={b.userPrompt} onChange={(e) => updateBeat(i, "userPrompt", e.target.value)} className="s-input" />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {TAGS.map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => copyTag(t)}
                                className="inline-flex items-center gap-1 font-mono text-xs text-primary bg-secondary px-2.5 py-1 rounded-lg border border-primary/15 hover:bg-primary/10 hover:border-primary/25 transition-all duration-200 active:scale-95"
                              >
                                {copiedTag === t ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                {t}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* ── Score Tab ── */}
            {tab === "score" && (
              <div className="space-y-4">
                <PromptHelp
                  what={
                    <>
                      This controls how the AI calculates the{" "}
                      <strong className="text-foreground">{audience}</strong>{" "}
                      <strong className="text-foreground">0–100 Belief Score</strong>{" "}
                      and its four sub-scores (Direction, Identity, Decision,
                      Energy). It produces <em>numbers</em>, not writing - the
                      written report lives on the{" "}
                      <strong className="text-foreground">“PDF report”</strong> tab.
                    </>
                  }
                  where="The big score and the four pillar bars on the results/summary page, and the score on the report cover."
                  placeholders={["{{NAME}}", "{{Q1}}", "{{Q2}}", "{{Q3}}", "{{Q4}}", "{{Q5}}"]}
                />

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6">
                    <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
                      <label className="eyebrow text-foreground/65">
                        Score - System prompt ({audience})
                      </label>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {current.scoreSystemPrompt.length} chars
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateScoreSystemPrompt(DEFAULT_SCORE_SYSTEM_PROMPT)}
                          className="h-8 rounded-full px-3 text-[10px] uppercase tracking-[0.18em] border-foreground/35 text-foreground hover:border-ink hover:text-ink"
                          title="Replace the textarea content with the built-in default prompt"
                        >
                          Load default
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      rows={16}
                      value={current.scoreSystemPrompt}
                      onChange={(e) => updateScoreSystemPrompt(e.target.value)}
                      placeholder="Score prompt that returns strict JSON with score, confidence, top 3 issues, and summary."
                      className="min-h-[300px] font-mono text-sm s-input resize-y"
                    />
                  </div>
                </div>

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6">
                    <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
                      <label className="eyebrow text-foreground/65">
                        Score - User prompt ({audience})
                      </label>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {current.scoreUserPrompt.length} chars
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateScoreUserPrompt(DEFAULT_SCORE_USER_PROMPT)}
                          className="h-8 rounded-full px-3 text-[10px] uppercase tracking-[0.18em] border-foreground/35 text-foreground hover:border-ink hover:text-ink"
                          title="Replace the textarea content with the built-in default user prompt"
                        >
                          Load default
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      rows={14}
                      value={current.scoreUserPrompt}
                      onChange={(e) => updateScoreUserPrompt(e.target.value)}
                      placeholder="User message template. Use {{NAME}} and {{Q1}}-{{Q5}} placeholders."
                      className="min-h-[260px] font-mono text-sm s-input resize-y"
                    />
                    <div className="flex flex-wrap gap-2 mt-3">
                      {["{{NAME}}", "{{Q1}}", "{{Q2}}", "{{Q3}}", "{{Q4}}", "{{Q5}}"].map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => copyTag(t)}
                          className="inline-flex items-center gap-1 font-mono text-xs text-primary bg-secondary px-2.5 py-1 rounded-lg border border-primary/15 hover:bg-primary/10 hover:border-primary/25 transition-all duration-200 active:scale-95"
                        >
                          {copiedTag === t ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── PDF Report Tab ── */}
            {tab === "report" && (
              <div className="space-y-4">
                <PromptHelp
                  what={
                    <>
                      This writes the multi-page{" "}
                      <strong className="text-foreground">{audience}</strong>{" "}
                      <strong className="text-foreground">PDF report</strong>{" "}
                      the buyer downloads - the headline, the four pillars, the
                      themes, the beat reflections, and the action steps. The{" "}
                      <em>number</em> on the cover comes from the{" "}
                      <strong className="text-foreground">“Score (0–100)”</strong> tab.
                    </>
                  }
                  where="The downloadable PDF report (and its on-screen preview) after a buyer completes checkout."
                  placeholders={[
                    "{{NAME}}",
                    "{{Q1}}",
                    "{{Q2}}",
                    "{{Q3}}",
                    "{{Q4}}",
                    "{{Q5}}",
                    "{{BEAT1}}",
                    "{{BEAT2}}",
                    "{{BEAT3}}",
                    "{{BEAT4}}",
                    "{{BEAT5}}",
                  ]}
                />

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6">
                    <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
                      <label className="eyebrow text-foreground/65">
                        PDF report - System prompt ({audience})
                      </label>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {current.reportSystemPrompt.length} chars
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateReportSystemPrompt(DEFAULT_REPORT_SYSTEM_PROMPT)}
                          className="h-8 rounded-full px-3 text-[10px] uppercase tracking-[0.18em] border-foreground/35 text-foreground hover:border-ink hover:text-ink"
                          title="Replace the textarea content with the built-in default prompt"
                        >
                          Load default
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      rows={24}
                      value={current.reportSystemPrompt}
                      onChange={(e) => updateReportSystemPrompt(e.target.value)}
                      placeholder="PDF report narrative prompt. Click 'Load default' to insert the built-in baseline."
                      className="min-h-[400px] font-mono text-sm s-input resize-y"
                    />
                  </div>
                </div>

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6">
                    <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
                      <label className="eyebrow text-foreground/65">
                        PDF report - User prompt ({audience})
                      </label>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {current.reportUserPrompt.length} chars
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateReportUserPrompt(DEFAULT_REPORT_USER_PROMPT)}
                          className="h-8 rounded-full px-3 text-[10px] uppercase tracking-[0.18em] border-foreground/35 text-foreground hover:border-ink hover:text-ink"
                          title="Replace the textarea content with the built-in default user prompt"
                        >
                          Load default
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      rows={20}
                      value={current.reportUserPrompt}
                      onChange={(e) => updateReportUserPrompt(e.target.value)}
                      placeholder="User message template. Use {{NAME}}, {{Q1}}-{{Q5}}, {{BEAT1}}-{{BEAT5}} placeholders."
                      className="min-h-[360px] font-mono text-sm s-input resize-y"
                    />
                    <div className="flex flex-wrap gap-2 mt-3">
                      {["{{NAME}}", "{{Q1}}", "{{Q2}}", "{{Q3}}", "{{Q4}}", "{{Q5}}", "{{BEAT1}}", "{{BEAT2}}", "{{BEAT3}}", "{{BEAT4}}", "{{BEAT5}}"].map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => copyTag(t)}
                          className="inline-flex items-center gap-1 font-mono text-xs text-primary bg-secondary px-2.5 py-1 rounded-lg border border-primary/15 hover:bg-primary/10 hover:border-primary/25 transition-all duration-200 active:scale-95"
                        >
                          {copiedTag === t ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Closing Summary Tab ── */}
            {tab === "summary" && (
              <div className="space-y-4">
                <PromptHelp
                  what={
                    <>
                      This writes the{" "}
                      <strong className="text-foreground">{audience}</strong>{" "}
                      <strong className="text-foreground">closing summary</strong> -
                      the warm 200–280 word message (and the audio version) that
                      plays at the end of the journey.
                    </>
                  }
                  where="The summary/results page - both the on-screen text and the “Listen” audio."
                  placeholders={[
                    "{{NAME}}",
                    "{{BEAT1}}",
                    "{{BEAT2}}",
                    "{{BEAT3}}",
                    "{{BEAT4}}",
                    "{{BEAT5}}",
                  ]}
                />

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6">
                    <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
                      <label className="eyebrow text-foreground/65">
                        Closing summary - System prompt ({audience})
                      </label>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {current.summarySystemPrompt.length} chars
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateSummarySystemPrompt(DEFAULT_SUMMARY_SYSTEM_PROMPT)}
                          className="h-8 rounded-full px-3 text-[10px] uppercase tracking-[0.18em] border-foreground/35 text-foreground hover:border-ink hover:text-ink"
                          title="Replace the textarea content with the built-in default prompt"
                        >
                          Load default
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      rows={20}
                      value={current.summarySystemPrompt}
                      onChange={(e) => updateSummarySystemPrompt(e.target.value)}
                      placeholder="Closing summary prompt. Click 'Load default' to insert the built-in baseline."
                      className="min-h-[360px] font-mono text-sm s-input resize-y"
                    />
                  </div>
                </div>

                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-6">
                    <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
                      <label className="eyebrow text-foreground/65">
                        Closing summary - User prompt ({audience})
                      </label>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {current.summaryUserPrompt.length} chars
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateSummaryUserPrompt(DEFAULT_SUMMARY_USER_PROMPT)}
                          className="h-8 rounded-full px-3 text-[10px] uppercase tracking-[0.18em] border-foreground/35 text-foreground hover:border-ink hover:text-ink"
                          title="Replace the textarea content with the built-in default user prompt"
                        >
                          Load default
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      rows={16}
                      value={current.summaryUserPrompt}
                      onChange={(e) => updateSummaryUserPrompt(e.target.value)}
                      placeholder="User message template. Use {{NAME}} and {{BEAT1}}-{{BEAT5}} placeholders."
                      className="min-h-[300px] font-mono text-sm s-input resize-y"
                    />
                    <div className="flex flex-wrap gap-2 mt-3">
                      {["{{NAME}}", "{{BEAT1}}", "{{BEAT2}}", "{{BEAT3}}", "{{BEAT4}}", "{{BEAT5}}"].map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => copyTag(t)}
                          className="inline-flex items-center gap-1 font-mono text-xs text-primary bg-secondary px-2.5 py-1 rounded-lg border border-primary/15 hover:bg-primary/10 hover:border-primary/25 transition-all duration-200 active:scale-95"
                        >
                          {copiedTag === t ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Responses Tab ── */}
            {tab === "responses" && (
              <div className="space-y-3">
                <div className="bg-card rounded-md s-card-static overflow-hidden">
                  <div className="p-4 space-y-3">
                    <form
                      onSubmit={(e) => { e.preventDefault(); void handleSearch() }}
                      className="flex gap-2"
                    >
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          placeholder="Search by name or email..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="pl-9 h-10 s-input"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowFilters(!showFilters)}
                        className={`h-10 rounded-full px-4 text-[10px] uppercase tracking-[0.22em] transition-colors duration-300 ${showFilters ? "border-ink text-ink" : "border-foreground/35 text-foreground hover:border-ink hover:text-ink"}`}
                      >
                        <Filter className="w-3 h-3 mr-1.5" />
                        Filters
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={searchLoading}
                        className="h-10 rounded-full font-medium text-[11px] uppercase tracking-[0.2em] bg-ink hover:bg-ink/85 text-background px-5"
                      >
                        {searchLoading ? "..." : "Search"}
                      </Button>
                      {isSearchActive && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={clearSearch}
                          className="h-10 rounded-full border border-foreground/35 text-foreground hover:border-destructive hover:text-destructive px-3"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      )}
                    </form>

                    {showFilters && (
                      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-border/60 animate-in fade-in slide-in-from-top-1 duration-200">
                        <div>
                          <label className="block eyebrow text-foreground/65 mb-1.5">From Date</label>
                          <Input type="date" value={searchDateFrom} onChange={(e) => setSearchDateFrom(e.target.value)} className="h-9 s-input text-sm" />
                        </div>
                        <div>
                          <label className="block eyebrow text-foreground/65 mb-1.5">To Date</label>
                          <Input type="date" value={searchDateTo} onChange={(e) => setSearchDateTo(e.target.value)} className="h-9 s-input text-sm" />
                        </div>
                        <div>
                          <label className="block eyebrow text-foreground/65 mb-1.5">Completion</label>
                          <select
                            title="Filter by completion status"
                            value={searchCompleted}
                            onChange={(e) => setSearchCompleted(e.target.value as "all" | "true" | "false")}
                            className="w-full h-9 s-input text-sm bg-background px-3"
                          >
                            <option value="all">All responses</option>
                            <option value="true">Completed (all 5 questions)</option>
                            <option value="false">Incomplete</option>
                          </select>
                        </div>
                        <div>
                          <label className="block eyebrow text-foreground/65 mb-1.5">Purchase</label>
                          <select
                            title="Filter by purchase status"
                            value={searchPurchased}
                            onChange={(e) => setSearchPurchased(e.target.value as "all" | "true" | "false")}
                            className="w-full h-9 s-input text-sm bg-background px-3"
                          >
                            <option value="all">All</option>
                            <option value="true">Purchased</option>
                            <option value="false">Not purchased</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {(() => {
                  const displayed = isSearchActive ? searchResults : responses
                  return displayed.length > 0 && (
                    <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-secondary/30 border border-primary/10">
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 cursor-pointer text-sm">
                          <input
                            type="checkbox"
                            checked={selectedIds.size === displayed.length && displayed.length > 0}
                            onChange={toggleSelectAll}
                            className="rounded border-foreground/30 accent-ink"
                          />
                          <span className="font-bold text-muted-foreground">
                            {selectedIds.size > 0 ? `${selectedIds.size} selected` : `Select all (${displayed.length})`}
                          </span>
                        </label>
                        {isSearchActive && (
                          <Badge variant="secondary" className="rounded-lg px-2 py-0.5 text-xs font-bold bg-ink/10 text-ink">
                            Search: {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {selectedIds.size > 0 && (
                          <Button type="button" variant="outline" size="sm" onClick={downloadSelected} className="h-8 rounded-full border border-foreground/35 text-foreground hover:border-ink hover:text-ink text-[10px] uppercase tracking-[0.2em] px-4">
                            <Download className="w-3.5 h-3.5 mr-1.5" />
                            Download Selected ({selectedIds.size})
                          </Button>
                        )}
                        {selectedIds.size > 0 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={deleteSelected}
                            disabled={deletingIds.size > 0}
                            className="h-8 rounded-full border border-destructive/45 text-destructive hover:border-destructive hover:bg-destructive/10 text-[10px] uppercase tracking-[0.2em] px-4 disabled:opacity-50"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                            {deletingIds.size > 0
                              ? "Deleting…"
                              : `Delete Selected (${selectedIds.size})`}
                          </Button>
                        )}
                        <Button type="button" variant="outline" size="sm" onClick={downloadAll} className="h-8 rounded-full border border-foreground/35 text-foreground hover:border-ink hover:text-ink text-[10px] uppercase tracking-[0.2em] px-4">
                          <Download className="w-3.5 h-3.5 mr-1.5" />
                          Download All
                        </Button>
                      </div>
                    </div>
                  )
                })()}

                {(responsesError || searchError) && (
                  <div className="p-3 rounded-xl bg-destructive/5 border-2 border-destructive/20 text-destructive text-sm">
                    {responsesError || searchError}
                  </div>
                )}

                {(responsesLoading && responses.length === 0 && !isSearchActive) || searchLoading ? (
                  // Skeleton mirrors the loaded list: summary strip + a few
                  // collapsed response rows.
                  <div className="space-y-3">
                    <Skeleton className="h-14 w-full rounded-md" />
                    {Array.from({ length: 5 }, (_, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 rounded-md border border-border bg-card p-4"
                      >
                        <Skeleton className="h-4 w-4 rounded" />
                        <Skeleton className="h-4 w-10" />
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-5 w-20 rounded-full" />
                        <Skeleton className="ml-auto h-4 w-32" />
                      </div>
                    ))}
                  </div>
                ) : (() => {
                  const displayed = isSearchActive ? searchResults : responses
                  return displayed.length === 0 && !responsesLoading ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      {isSearchActive ? "No responses match your search." : "No user responses yet."}
                    </div>
                  ) : (
                    <>
                      {!isSearchActive && (
                        <div className="rounded-md border border-border bg-secondary/40 p-4 text-[14px] leading-[1.7] text-foreground/85">
                          Showing <strong className="text-foreground">{responses.length}</strong> user submission{responses.length !== 1 ? "s" : ""}, newest first.
                        </div>
                      )}

                      {displayed.map((r) => {
                        const open = !!expandedResponses[r.id]
                        // Calmed Marine palette: foreground = body, ink = heading.
                        // Main (incl. legacy "individual"/"team" rows) reads
                        // quiet; any other vertical gets the ink-tinted chip so
                        // non-main traffic stands out at a glance.
                        const isMainVertical =
                          !r.audience ||
                          r.audience === "main" ||
                          r.audience === "individual" ||
                          r.audience === "team"
                        const audienceBadge = isMainVertical
                          ? "bg-secondary text-ink border-border"
                          : "bg-ink/10 text-ink border-ink/20"
                        return (
                          <div key={r.id} className={`bg-card rounded-md overflow-hidden transition-all duration-300 ${open ? "s-card" : "s-card-static"}`}>
                            <div className="flex items-center">
                              <label className="flex items-center pl-4 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  title={`Select response #${r.id}`}
                                  checked={selectedIds.has(r.id)}
                                  onChange={() => toggleSelectId(r.id)}
                                  className="rounded border-foreground/30 accent-ink"
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() => toggleResponse(r.id)}
                                className="flex-1 flex items-center gap-3 p-4 text-left hover:bg-secondary/30 transition-colors duration-200"
                              >
                                <Badge variant="outline" className="rounded-lg bg-ink/10 text-ink border-ink/20 text-xs font-bold shrink-0">
                                  #{r.id}
                                </Badge>
                                <Badge variant="outline" className={`rounded-full text-[10px] uppercase tracking-[0.2em] shrink-0 ${audienceBadge}`}>
                                  {r.audience || "-"}
                                </Badge>
                                {/* DOORWAY - which landing page handed them off,
                                    from the lp/vertical param it appended.
                                    Distinct from the badge on its left, which is
                                    the VERTICAL they actually ran. Previously this
                                    fell back to the literal "main" when no landing
                                    page was involved, which mislabelled e.g. a
                                    retargeting-subdomain visitor as "MAIN". No
                                    doorway now reads as "direct". */}
                                {/* Exactly ONE vertical indicator here: the
                                    funnel they actually went through (the
                                    audience badge above). The doorway/lp slug
                                    used to sit beside it and read as a second,
                                    contradictory vertical - it lives in the
                                    expanded "Source / Session" block as
                                    "Funnel", where it belongs. */}
                                <div className="flex-1 min-w-0">
                                  <p className="eyebrow text-foreground/70">{r.firstName || "-"}</p>
                                  <p className="text-sm text-foreground truncate mt-0.5">{r.email || "-"}</p>
                                </div>
                                {/* A re-signup patches the existing row rather than
                                    creating a new one, so flag it explicitly -
                                    otherwise a returning lead looks identical to
                                    a brand-new one. */}
                                {(r.signupCount ?? 1) > 1 && (
                                  <Badge
                                    variant="outline"
                                    className="rounded-lg border-ink/25 text-[10px] font-bold shrink-0 mr-1 text-foreground/80"
                                    title={
                                      r.firstSignupAt
                                        ? `First signed up ${formatDate(r.firstSignupAt)}`
                                        : undefined
                                    }
                                  >
                                    ×{r.signupCount} signups
                                  </Badge>
                                )}
                                <Badge variant="secondary" className={`rounded-lg text-[10px] font-bold shrink-0 mr-1 ${r.answered?.[4] ? "bg-green-500/10 text-green-600 border-green-500/20" : "bg-amber-500/10 text-amber-600 border-amber-500/20"}`}>
                                  {r.answered?.[4] ? "Complete" : "Incomplete"}
                                </Badge>
                                <span className="text-xs text-muted-foreground shrink-0 mr-2">{formatDate(r.createdAt)}</span>
                                <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
                              </button>
                              <button
                                type="button"
                                onClick={() => downloadResponses([r])}
                                className="pl-1 pr-1 text-muted-foreground hover:text-ink transition-colors"
                                title="Download this response"
                              >
                                <Download className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void deleteResponses([r])}
                                disabled={deletingIds.has(r.id)}
                                className="pr-4 pl-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                                title="Delete this response permanently"
                                aria-label={`Delete response #${r.id}`}
                              >
                                {deletingIds.has(r.id) ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                              </button>
                            </div>

                            {open && (
                              <div className="border-t border-border/60 p-5 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                                <p className="eyebrow text-foreground/65 pb-1.5 border-b border-border">
                                  Contact
                                </p>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
                                  {r.email ? (
                                    <a
                                      href={`mailto:${r.email}`}
                                      className="text-ink hover:underline break-all"
                                    >
                                      {r.email}
                                    </a>
                                  ) : (
                                    <span className="text-muted-foreground italic text-xs">No email</span>
                                  )}
                                  {r.phone ? (
                                    <a
                                      href={`https://wa.me/${r.phone.replace(/\D/g, "")}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-3 py-1 text-[13px] font-medium text-green-700 ring-1 ring-green-500/20 transition-colors hover:bg-green-500/15"
                                      title="Open WhatsApp chat"
                                    >
                                      <MessageCircle className="h-3.5 w-3.5" />
                                      {r.phone}
                                    </a>
                                  ) : (
                                    <span className="text-muted-foreground italic text-xs">No phone</span>
                                  )}
                                </div>

                                <Separator />
                                <p className="eyebrow text-foreground/65 pb-1.5 border-b border-border">
                                  Answers
                                </p>
                                {[1, 2, 3, 4, 5].map((n) => {
                                  const answered = r.answered?.[n - 1] === true
                                  const promptText = (r[`question${n}_text` as keyof typeof r] as string | undefined) || ""
                                  return (
                                    <div key={`q${n}`}>
                                      <label className="block eyebrow text-foreground/65 mb-1">Question {n}</label>
                                      {promptText ? (
                                        <div className="mb-2 px-3 py-2 rounded-lg bg-secondary/40 border border-border/60 text-[13px] text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
                                          <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 mb-0.5">Prompt shown</span>
                                          {promptText}
                                        </div>
                                      ) : (
                                        <div className="mb-2 text-[12px] italic text-muted-foreground/70">
                                          Prompt text not captured (answered before this feature shipped).
                                        </div>
                                      )}
                                      {/* Answer text is private user data and is never sent to this console. */}
                                      <div className="text-sm text-muted-foreground italic">
                                        {answered ? "Answered (hidden for privacy)" : "No answer"}
                                      </div>
                                    </div>
                                  )
                                })}

                                <Separator />
                                <p className="eyebrow text-foreground/65 pb-1.5 border-b border-border">
                                  Beat Feedback
                                </p>
                                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                                  {[1, 2, 3, 4, 5].map((n) => {
                                    const val = r[`beat${n}_feedback` as keyof typeof r] || ""
                                    return (
                                      <div key={`fb${n}`}>
                                        <label className="block eyebrow text-foreground/65 mb-1">Beat {n}</label>
                                        {/* Explicit text colour: the chip used to inherit a dark
                                            ink on the dark marine card and was unreadable. */}
                                        <span className="inline-block max-w-full whitespace-pre-wrap break-words rounded-lg border border-border bg-secondary/60 px-2.5 py-1 text-sm leading-snug text-foreground">
                                          {val || <span className="text-muted-foreground">-</span>}
                                        </span>
                                      </div>
                                    )
                                  })}
                                </div>

                                <Separator />
                                <p className="eyebrow text-foreground/65 pb-1.5 border-b border-border">
                                  Beat Outputs
                                </p>
                                {[1, 2, 3, 4, 5].map((n) => {
                                  // String() because the row type now carries a
                                  // numeric field (signupCount), which widens
                                  // this indexed lookup to string | number.
                                  const val = String(r[`beat${n}_output` as keyof typeof r] ?? "")
                                  const outKey = `${r.id}-beat${n}`
                                  const outOpen = !!expandedOutputs[outKey]
                                  if (!val) return (
                                    <div key={`bo${n}`}>
                                      <label className="block eyebrow text-foreground/65 mb-1">Beat {n} Output</label>
                                      <span className="text-muted-foreground italic text-sm">No output</span>
                                    </div>
                                  )
                                  return (
                                    <div key={`bo${n}`}>
                                      <button
                                        type="button"
                                        onClick={() => toggleOutput(outKey)}
                                        className="flex items-center justify-between w-full mb-1.5 group"
                                      >
                                        <label className="eyebrow text-foreground/65 cursor-pointer">Beat {n} Output</label>
                                        <span className="text-xs text-ink group-hover:underline">
                                          {outOpen ? "Collapse" : `${val.length} chars - Click to expand`}
                                        </span>
                                      </button>
                                      {outOpen && (
                                        <div className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words max-h-96 overflow-y-auto bg-muted/30 border border-border rounded-xl p-3 animate-in fade-in duration-200">
                                          {val}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}

                                <ResponseOutputs
                                  r={r}
                                  onViewReport={(data, name, id, dateISO) =>
                                    setReportModal({
                                      data,
                                      name,
                                      id,
                                      dateISO,
                                      // Render the report with the vocabulary of the
                                      // vertical this respondent actually ran.
                                      vertical: normalizeVertical(r.audience) ?? "main",
                                    })
                                  }
                                />
                                <ResponseSourceDetails r={r} />
                                {isTech && <ResponseTechDetails r={r} />}
                              </div>
                            )}
                          </div>
                        )
                      })}

                      {!isSearchActive && responsesHasMore && (
                        <div className="text-center mt-4">
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-full border border-foreground/35 text-foreground hover:border-ink hover:text-ink text-[10px] uppercase tracking-[0.2em] px-8 "
                            disabled={responsesLoading}
                            onClick={() => loadResponses(responsesOffset)}
                          >
                            {responsesLoading ? "Loading..." : "Load More"}
                          </Button>
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            )}


            {tab === "analytics" && isTech && <AnalyticsPanel />}
          </div>
        )}
      </main>

      {/* Report preview modal - renders a persisted report_json via the shared
          ReportView and exports the same client-generated PDF the user got. */}
      {reportModal && (
        <div
          className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!reportPdfBusy) setReportModal(null)
          }}
        >
          <div className="flex min-h-full flex-col items-center px-4 py-8">
            <div
              className="sticky top-0 z-10 mb-4 flex w-full max-w-3xl items-center justify-between gap-3 rounded-full border border-border bg-background/95 px-4 py-2 shadow-lg backdrop-blur"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="truncate text-sm font-bold text-foreground">
                Report · {reportModal.name || "-"} (#{reportModal.id})
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={reportPdfBusy}
                  onClick={async () => {
                    const root = reportModalRef.current
                    if (!root) return
                    setReportPdfBusy(true)
                    try {
                      await downloadReportPdf(
                        root,
                        `${reportFileSlug(reportModal.name)}-${reportModal.vertical}-report.pdf`
                      )
                    } catch (err) {
                      console.error("Admin PDF download failed:", err)
                    } finally {
                      setReportPdfBusy(false)
                    }
                  }}
                  className="h-9 rounded-full bg-ink px-4 text-[10px] uppercase tracking-[0.2em] text-background hover:bg-ink/85"
                >
                  {reportPdfBusy ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Preparing…
                    </>
                  ) : (
                    <>
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      Download PDF
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={reportPdfBusy}
                  onClick={() => setReportModal(null)}
                  className="h-9 w-9 rounded-full border border-foreground/35 p-0 text-foreground hover:border-destructive hover:text-destructive"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div
              ref={reportModalRef}
              className="w-full max-w-3xl overflow-x-auto rounded-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <ReportView
                data={reportModal.data}
                name={reportModal.name}
                dateISO={reportModal.dateISO}
                vertical={reportModal.vertical}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
