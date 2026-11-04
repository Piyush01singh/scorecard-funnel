import { CosmosClient, type Container, type Database } from "@azure/cosmos"
import {
  ADMIN_USER_PROJECTION,
  ANSWERED_PREDICATE,
  toAdminUserView,
  type AdminUserView,
} from "@/lib/server/admin-user-view"

/* ═══════════════════════════════════════════════
   Cosmos DB Client — replaces Google Sheets
   ═══════════════════════════════════════════════ */

const ENDPOINT = process.env.COSMOS_ENDPOINT ?? ""
const KEY = process.env.COSMOS_KEY ?? ""
const DB_NAME = process.env.COSMOS_DATABASE ?? "funnel-db"

let _client: CosmosClient | null = null
let _db: Database | null = null
let _initialized = false

function getClient(): CosmosClient {
  if (!_client) {
    if (!ENDPOINT || !KEY) throw new Error("Cosmos DB is not configured")
    _client = new CosmosClient({ endpoint: ENDPOINT, key: KEY })
  }
  return _client
}

function getDatabase(): Database {
  if (!_db) {
    _db = getClient().database(DB_NAME)
  }
  return _db
}

/** Auto-create database and containers if they don't exist (runs once). */
async function ensureInitialized(): Promise<void> {
  if (_initialized) return
  const client = getClient()
  await client.databases.createIfNotExists({ id: DB_NAME })
  const db = getDatabase()
  await db.containers.createIfNotExists({ id: "users", partitionKey: { paths: ["/email"] } })
  await db.containers.createIfNotExists({ id: "prompts", partitionKey: { paths: ["/id"] } })
  _initialized = true
  // One-time (best-effort): give any legacy row a `createdAt` so the admin
  // list can ORDER BY it without dropping rows. Never blocks init.
  await backfillCreatedAt().catch(() => {})
}

/**
 * Backfill `createdAt` onto user rows that predate the field, deriving it from
 * the Cosmos system `_ts` (epoch SECONDS). The admin list orders by a bare
 * `ORDER BY c.createdAt`, which silently drops rows missing that field — so
 * without this, legacy rows would vanish. Idempotent (only touches rows where
 * createdAt is absent) and best-effort: any failure is swallowed so a
 * transient DB hiccup never breaks reads. Runs at most once per process.
 */
let _backfilledCreatedAt = false
async function backfillCreatedAt(): Promise<void> {
  if (_backfilledCreatedAt) return
  _backfilledCreatedAt = true
  const container = getDatabase().container("users")
  // Find real user rows lacking createdAt. Projecting id/email/_ts keeps the
  // scan cheap; no ORDER BY (which would itself drop these very rows).
  const { resources } = await container.items
    .query<{ id: string; email: string; _ts: number }>(
      "SELECT c.id, c.email, c._ts FROM c WHERE IS_DEFINED(c.email) AND (NOT IS_DEFINED(c.createdAt) OR c.createdAt = '' OR c.createdAt = null)"
    )
    .fetchAll()
  if (!resources?.length) return
  for (const row of resources) {
    const iso = new Date((row._ts ?? 0) * 1000).toISOString()
    try {
      await container.item(row.id, row.email).patch([
        { op: "add", path: "/createdAt", value: iso },
      ])
    } catch {
      /* skip this row; a later init will retry it */
    }
  }
}

function usersContainer(): Container {
  return getDatabase().container("users")
}

function promptsContainer(): Container {
  return getDatabase().container("prompts")
}

export function isCosmosConfigured(): boolean {
  return Boolean(ENDPOINT && KEY && DB_NAME)
}

/* ═══════════════════════════════════════════════
   Users — paginated read (admin)
   ═══════════════════════════════════════════════ */

export type Audience = import("@/lib/verticals").Vertical

export type UserDocument = {
  id: string
  firstName: string
  email: string
  /** Optional WhatsApp/phone for sales follow-up, captured at signup. */
  phone?: string
  audience: Audience | ""
  question1: string
  question2: string
  question3: string
  question4: string
  question5: string
  // Snapshot of the question text the user actually saw at the time they answered.
  // Required because the admin can change question wording and we still need to
  // know what each user was responding to.
  question1_text: string
  question2_text: string
  question3_text: string
  question4_text: string
  question5_text: string
  beat1_feedback: string
  beat2_feedback: string
  beat3_feedback: string
  beat4_feedback: string
  beat5_feedback: string
  beat1_output: string
  beat2_output: string
  beat3_output: string
  beat4_output: string
  beat5_output: string
  // Final user-facing outputs, persisted at generation time so the admin can
  // review/download exactly what each tester received. All four are optional
  // because they only exist once the user reaches the summary/report stage,
  // and older documents predate this feature.
  //   score_json   — JSON of { overall, subscores, band, reasons, nsState, scoreSource }
  //   report_json  — JSON of the full /api/challenge/report payload
  //   summary_text — the closing summary prose
  //   summary_audio_url — Vercel Blob URL of the summary MP3 (audio is too
  //                       large for a Cosmos item, so only the URL is stored)
  score_json?: string
  report_json?: string
  summary_text?: string
  summary_audio_url?: string
  // Tech-analytics telemetry (/techadmin). Captured client-side so a session
  // recording in PostHog can be tied back to a specific tester.
  ph_session_id?: string
  ph_distinct_id?: string
  // First-touch acquisition attribution, captured client-side at the landing
  // and persisted at signup. All optional — direct/organic visits and
  // documents that predate this feature simply omit them.
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_term?: string
  utm_content?: string
  // Ad-platform click IDs + cross-reference to the originating landing page
  // (ref = that page's lead/record id; lp = which landing page forwarded them).
  fbclid?: string
  gclid?: string
  ttclid?: string
  msclkid?: string
  ref?: string
  lp?: string
  /** Funnel/vertical the session came from (e.g. "adhd", "traders", "main"). */
  vertical?: string
  referrer?: string
  landing_page?: string
  // Purchase record. Written by the Stripe webhook (authoritative) and/or the
  // thank-you page (covers Calendly tiers, which never hit the Stripe webhook).
  paid_tier?: string
  paid_amount?: string
  paid_at?: string
  /** Set when the lead reached the offer page (see UserOutputField). */
  offer_viewed_at?: string
  /**
   * Sort key for the admin list. Set at row creation AND bumped on every
   * re-signup, so a returning lead surfaces at the top where the team looks
   * for it. (Before this, a re-signup silently patched the old row and left
   * its date untouched, so it stayed buried and read as "never registered".)
   */
  createdAt: string
  /** The TRUE first signup time, preserved when createdAt is bumped above.
   *  Absent on rows that have only ever signed up once. */
  firstSignupAt?: string
  /** How many times this email has submitted the signup form. */
  signupCount?: number
}

/** First-touch acquisition attribution captured at signup. */
export type Attribution = {
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
  vertical?: string
  referrer?: string
  landing_page?: string
}

// Per-field cap for attribution values. URLs/UTM tags are short; this guards
// against an abusive client inflating the document.
const MAX_ATTRIBUTION_LEN = 500

/** Trim attribution values to the whitelisted keys, dropping empties + capping length. */
function sanitizeAttribution(attribution?: Attribution): Record<string, string> {
  const keys: (keyof Attribution)[] = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "ttclid",
    "msclkid",
    "ref",
    "lp",
    "vertical",
    "referrer",
    "landing_page",
  ]
  const out: Record<string, string> = {}
  if (!attribution) return out
  for (const key of keys) {
    const value = attribution[key]
    if (typeof value === "string" && value.trim().length > 0) {
      out[key] = value.slice(0, MAX_ATTRIBUTION_LEN)
    }
  }
  return out
}

/** Output fields the summary/report stage persists. Kept narrow so callers
 *  can't accidentally patch arbitrary columns through the outputs endpoint. */
export type UserOutputField =
  | "score_json"
  | "report_json"
  | "summary_text"
  | "summary_audio_url"
  /** ISO timestamp: this lead reached the offer page. Funnel visibility
   *  only - lets the journey separate "saw the offer" from "purchased". */
  | "offer_viewed_at"

// Maximum bytes we accept for the prompt-text snapshot. Guards against an
// abusive client inflating documents past the 2 MB Cosmos item limit.
const MAX_QUESTION_TEXT_LEN = 4000

// Stateless OFFSET/LIMIT pagination. Cross-partition ORDER BY queries lose
// their in-memory merge buffer when the iterator is rebuilt from just a
// continuation token, which surfaces as empty pages with hasMore=true. The
// offset form is partition-safe, stateless on the server, and acceptable on
// RU cost for the admin panel's volumes.
export async function fetchUsers(
  pageSize = 25,
  offset = 0
): Promise<{ users: AdminUserView[]; nextOffset: number; hasMore: boolean }> {
  await ensureInitialized()
  const container = usersContainer()

  // Fetch pageSize + 1 to detect hasMore in a single round-trip.
  const probe = pageSize + 1
  // Order by SIGNUP DATE, newest first, so the list matches the `createdAt`
  // shown in the admin UI. NOTE: Cosmos only supports ORDER BY on a bare
  // indexed property path — an expression like `(c.createdAt ?? c._ts)` throws
  // a query error (500 -> our 502). And Cosmos silently DROPS any document
  // missing the ORDER BY field. Both concerns are handled by backfilling
  // `createdAt` onto every legacy row at init (see backfillCreatedAt), so a
  // plain `ORDER BY c.createdAt` is now safe and complete. The
  // `IS_DEFINED(c.email)` filter keeps the internal serial-counter doc out.
  // Projected, never SELECT *: raw answers are private and must not leave
  // Cosmos for the admin list (see admin-user-view.ts).
  const querySpec = {
    query: `SELECT ${ADMIN_USER_PROJECTION} FROM c WHERE IS_DEFINED(c.email) ORDER BY c.createdAt DESC OFFSET @offset LIMIT @limit`,
    parameters: [
      { name: "@offset", value: offset },
      { name: "@limit", value: probe },
    ],
  }

  const { resources } = await container.items
    .query<Record<string, unknown>>(querySpec)
    .fetchAll()

  const all = (resources ?? []).map(toAdminUserView)
  const hasMore = all.length > pageSize
  const users = hasMore ? all.slice(0, pageSize) : all

  return { users, nextOffset: offset + users.length, hasMore }
}

export async function searchUsers(opts: {
  query?: string
  dateFrom?: string
  dateTo?: string
  hasCompleted?: boolean
  hasPurchased?: boolean
}): Promise<AdminUserView[]> {
  await ensureInitialized()
  const container = usersContainer()

  const conditions: string[] = []
  const params: { name: string; value: string | boolean }[] = []

  if (opts.query) {
    const q = opts.query.toLowerCase()
    // Name/email/prompt text only. Answers are deliberately NOT searchable:
    // a match is itself an oracle on private answer content.
    conditions.push(
      "(CONTAINS(LOWER(c.firstName), @q) OR CONTAINS(LOWER(c.email), @q) OR CONTAINS(LOWER(c.question1_text ?? ''), @q) OR CONTAINS(LOWER(c.question2_text ?? ''), @q) OR CONTAINS(LOWER(c.question3_text ?? ''), @q) OR CONTAINS(LOWER(c.question4_text ?? ''), @q) OR CONTAINS(LOWER(c.question5_text ?? ''), @q))"
    )
    params.push({ name: "@q", value: q })
  }

  if (opts.dateFrom) {
    conditions.push("c.createdAt >= @dateFrom")
    params.push({ name: "@dateFrom", value: opts.dateFrom })
  }

  if (opts.dateTo) {
    conditions.push("c.createdAt <= @dateTo")
    params.push({ name: "@dateTo", value: opts.dateTo + "T23:59:59.999Z" })
  }

  if (opts.hasCompleted === true) {
    conditions.push(ANSWERED_PREDICATE("question5"))
  } else if (opts.hasCompleted === false) {
    conditions.push(`NOT ${ANSWERED_PREDICATE("question5")}`)
  }

  // Purchase filter — a row counts as purchased once the Stripe webhook /
  // thank-you page has stamped paid_tier (same signal fetchFunnelStats uses).
  if (opts.hasPurchased === true) {
    conditions.push("(IS_DEFINED(c.paid_tier) AND c.paid_tier != '')")
  } else if (opts.hasPurchased === false) {
    conditions.push("(NOT IS_DEFINED(c.paid_tier) OR c.paid_tier = '')")
  }

  // Always filter to real user rows (excludes the serial-counter doc) and order
  // by signup date, newest first. Bare `ORDER BY c.createdAt` — Cosmos rejects
  // expression ORDER BYs; every row has createdAt after the init backfill, so
  // none are dropped. See the note in fetchUsers.
  const where = ` WHERE ${["IS_DEFINED(c.email)", ...conditions].join(" AND ")}`
  const querySpec = {
    query: `SELECT ${ADMIN_USER_PROJECTION} FROM c${where} ORDER BY c.createdAt DESC`,
    parameters: params,
  }

  const { resources } = await container.items
    .query<Record<string, unknown>>(querySpec)
    .fetchAll()
  return (resources ?? []).map(toAdminUserView)
}

/* ═══════════════════════════════════════════════
   Prompts container (key-value store)
   ═══════════════════════════════════════════════ */

/** Read all key-value pairs from the prompts container. */
export async function readPrompts(): Promise<Record<string, string>> {
  await ensureInitialized()
  const container = promptsContainer()

  // Retry transient failures (ETIMEDOUT / 429 / socket resets) before giving
  // up. This read backs ALL funnel copy, and on a cold start there is no
  // warm cache to fall back to - a single blip would otherwise serve an
  // ADHD or healthcare visitor the generic default copy, silently and with
  // ad spend running. Two fast retries make that vanishingly unlikely.
  let resources: Array<{ id?: string; value?: unknown }> = []
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await container.items
        .query("SELECT c.id, c[\"value\"] FROM c")
        .fetchAll()
      resources = res.resources
      lastErr = undefined
      break
    } catch (e) {
      lastErr = e
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  if (lastErr) throw lastErr

  const result: Record<string, string> = {}
  for (const item of resources) {
    // Skip internal control documents (e.g. the serial-number counter)
    // so the admin prompts editor never sees them as editable prompts.
    if (typeof item.id === "string" && item.id.startsWith("__")) continue
    if (item.id && item.value !== undefined) {
      result[item.id] = String(item.value)
    }
  }
  return result
}

/** Write key-value pairs to the prompts container. Upserts each entry. */
export async function writePrompts(data: Record<string, string>): Promise<void> {
  await ensureInitialized()
  const container = promptsContainer()

  const entries = Object.entries(data)
  // Cosmos serverless / 400-RU containers throttle (429) when too many
  // upserts land in the same instant. The admin save now ships 70+ keys
  // (system + user prompts × 3 generators × 2 audiences + beats + questions),
  // so a flat Promise.all over all of them hit RU limits and surfaced as
  // "HTTP 502 / Failed to write prompts" in the UI with no save going through.
  // Chunking to a small concurrent batch keeps every key, just paced.
  const BATCH = 8
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH)
    await Promise.all(
      slice.map(([key, value]) => container.items.upsert({ id: key, value })),
    )
  }
}

/* ═══════════════════════════════════════════════
   Users container
   ═══════════════════════════════════════════════ */

/**
 * Atomically allocate the next serial number using a singleton counter
 * document with ETag-based optimistic concurrency. Two concurrent signups
 * will see the same ETag, only one's `replace` will succeed; the loser
 * gets 412 PreconditionFailed and retries — guaranteeing unique, gap-free
 * serial numbers under concurrency.
 *
 * The counter lives in the `prompts` container (keyed by /id) under the
 * id "__sno_counter" so we don't need a third container. On first call
 * (counter doc absent) we seed it from MAX(c.id) in the users container
 * so existing data isn't skipped. This migration path runs at most once
 * per deployment.
 */
const SNO_COUNTER_ID = "__sno_counter"
const SNO_MAX_ATTEMPTS = 10

async function seedCounterFromUsersMax(): Promise<number> {
  const users = usersContainer()
  const { resources } = await users.items
    .query("SELECT VALUE MAX(StringToNumber(c.id)) FROM c")
    .fetchAll()
  const max = resources[0]
  return typeof max === "number" && !Number.isNaN(max) ? max : 0
}

async function getNextSerialNumber(): Promise<number> {
  const counter = promptsContainer()
  for (let attempt = 0; attempt < SNO_MAX_ATTEMPTS; attempt++) {
    try {
      const { resource, etag } = await counter
        .item(SNO_COUNTER_ID, SNO_COUNTER_ID)
        .read<{ id: string; value: number }>()

      if (!resource) {
        // First-ever allocation — seed from existing users so we don't
        // hand out colliding ids for data that pre-dates the counter.
        const seed = await seedCounterFromUsersMax()
        try {
          await counter.items.create(
            { id: SNO_COUNTER_ID, value: seed + 1 },
            { accessCondition: { type: "IfNoneMatch", condition: "*" } },
          )
          return seed + 1
        } catch (e: unknown) {
          // Another process created the counter at the same time — fall
          // through to the read+CAS path on the next loop iteration.
          const code = (e as { code?: number })?.code
          if (code !== 409 /* Conflict */) throw e
          continue
        }
      }

      const current = typeof resource.value === "number" ? resource.value : 0
      const next = current + 1
      try {
        await counter
          .item(SNO_COUNTER_ID, SNO_COUNTER_ID)
          .replace(
            { id: SNO_COUNTER_ID, value: next },
            { accessCondition: { type: "IfMatch", condition: etag ?? "" } },
          )
        return next
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code
        if (code === 412 /* PreconditionFailed — lost the CAS race */) continue
        throw e
      }
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code
      if (code === 404) {
        // Counter doc missing AND read threw 404 rather than returning
        // undefined — retry the loop to take the seed path.
        continue
      }
      throw e
    }
  }
  throw new Error(
    `[cosmos-db] Failed to allocate serial number after ${SNO_MAX_ATTEMPTS} CAS attempts`,
  )
}

/**
 * Most recent INCOMPLETE row (no Q5 answer) for this email, matched
 * case-insensitively. Used to reuse an abandoned signup instead of duplicating
 * it. Cross-partition (email is the partition key, but users type it with
 * varying case), which is fine at this volume.
 */
async function findReusableSignup(email: string): Promise<UserDocument | null> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return null
  const container = usersContainer()
  const { resources } = await container.items
    .query({
      query:
        'SELECT * FROM c WHERE LOWER(c.email) = @email AND (NOT IS_DEFINED(c.question5) OR c.question5 = "") ORDER BY c.createdAt DESC',
      parameters: [{ name: "@email", value: normalized }],
    })
    .fetchAll()
  return (resources[0] as UserDocument) ?? null
}

/**
 * Signup. Reuses an existing INCOMPLETE row for the same email when one exists,
 * otherwise creates a new document. Returns the row's S.No (stored as `id`).
 *
 * Why reuse: every signup used to create a brand-new row, so a visitor who
 * abandoned before answering — or who re-submitted the form on a later visit /
 * via the back button — left an empty "Incomplete" row behind for each attempt
 * (the classic "one user, two rows, one always incomplete" duplicate). A row
 * that already has answers (Complete) is never reused, so a genuine retake
 * still gets its own fresh row.
 */
export async function appendSignupRow(
  firstName: string,
  email: string,
  audience: Audience | "" = "",
  attribution?: Attribution,
  phone?: string
): Promise<number> {
  await ensureInitialized()
  const container = usersContainer()

  const reusable = await findReusableSignup(email)
  if (reusable) {
    try {
      // Latest name/audience/phone win; first-touch attribution is preserved —
      // we only fill attribution keys the original row was missing.
      const now = new Date().toISOString()
      const ops: { op: "set"; path: string; value: string | number }[] = [
        { op: "set", path: "/firstName", value: firstName },
        { op: "set", path: "/audience", value: audience },
        // Bump the sort key so this re-signup surfaces at the top of the
        // admin list. Without this the row keeps its original date, stays
        // buried, and the team reads it as "the signup never registered" —
        // which is exactly what happened in production on 2026-07-29.
        { op: "set", path: "/createdAt", value: now },
        { op: "set", path: "/signupCount", value: (reusable.signupCount ?? 1) + 1 },
      ]
      // Preserve the TRUE first signup time the first time we bump.
      if (!reusable.firstSignupAt) {
        ops.push({
          op: "set",
          path: "/firstSignupAt",
          value: reusable.createdAt || now,
        })
      }
      if (phone) {
        ops.push({ op: "set", path: "/phone", value: phone.trim().slice(0, 40) })
      }
      for (const [k, v] of Object.entries(sanitizeAttribution(attribution))) {
        if (!reusable[k as keyof UserDocument]) {
          ops.push({ op: "set", path: `/${k}`, value: v })
        }
      }
      await container.item(reusable.id, reusable.email).patch(ops)
      return Number(reusable.id)
    } catch (e) {
      console.error(
        "[cosmos-db] appendSignupRow: reuse patch failed, creating fresh row",
        (e as Error)?.message?.slice(0, 120),
      )
      // fall through to create a new row
    }
  }

  const sno = await getNextSerialNumber()

  await container.items.create({
    id: String(sno),
    firstName,
    email,
    phone: (phone ?? "").trim().slice(0, 40),
    audience,
    // First-touch acquisition attribution (utm_* / referrer / landing_page),
    // spread in only for the keys that are present.
    ...sanitizeAttribution(attribution),
    question1: "",
    question2: "",
    question3: "",
    question4: "",
    question5: "",
    question1_text: "",
    question2_text: "",
    question3_text: "",
    question4_text: "",
    question5_text: "",
    beat1_feedback: "",
    beat2_feedback: "",
    beat3_feedback: "",
    beat4_feedback: "",
    beat5_feedback: "",
    beat1_output: "",
    beat2_output: "",
    beat3_output: "",
    beat4_output: "",
    beat5_output: "",
    createdAt: new Date().toISOString(),
    // Equal on a first signup; createdAt is bumped on later re-signups
    // while firstSignupAt stays put (see the reuse branch above).
    firstSignupAt: new Date().toISOString(),
    signupCount: 1,
  })

  return sno
}

/**
 * Permanently delete user rows by serial number (id). Admin-only.
 *
 * Cosmos deletes require the partition key (email), which the caller does
 * not send - so each id is resolved to its row first. A missing row counts
 * as "already gone" rather than an error, which keeps the operation
 * idempotent (a double-click can't produce a failure).
 *
 * The serial counter is deliberately NOT rewound: serial numbers must stay
 * unique forever, since they are the join key on every answer/beat write
 * and on Stripe's client_reference_id.
 */
export async function deleteUserRows(
  ids: string[]
): Promise<{ deleted: string[]; missing: string[]; failed: string[] }> {
  await ensureInitialized()
  const container = usersContainer()
  const deleted: string[] = []
  const missing: string[] = []
  const failed: string[] = []

  for (const rawId of ids) {
    const id = String(rawId).trim()
    if (!id) continue
    try {
      // Resolve the partition key (email) for this id.
      const { resources } = await container.items
        .query<{ id: string; email: string }>({
          query: "SELECT c.id, c.email FROM c WHERE c.id = @id",
          parameters: [{ name: "@id", value: id }],
        })
        .fetchAll()
      const row = resources[0]
      if (!row?.email) {
        missing.push(id)
        continue
      }
      await container.item(row.id, row.email).delete()
      deleted.push(id)
    } catch (e) {
      const code = (e as { code?: number | string })?.code
      if (code === 404 || code === "NotFound") {
        missing.push(id)
      } else {
        console.error(
          "[cosmos-db] deleteUserRows failed for id",
          id,
          (e as Error)?.message?.slice(0, 120)
        )
        failed.push(id)
      }
    }
  }

  return { deleted, missing, failed }
}

/**
 * Atomically set one or more fields on a user document. All ops land in a
 * single Cosmos patch so multi-field writes (e.g. answer + question-text
 * snapshot) cannot half-apply.
 */
async function updateUserFields(
  serialNumber: number,
  firstName: string,
  email: string,
  fields: Record<string, string>
): Promise<void> {
  const fieldEntries = Object.entries(fields)
  if (fieldEntries.length === 0) return

  await ensureInitialized()
  const container = usersContainer()
  const id = String(serialNumber)
  const ops = fieldEntries.map(([field, value]) => ({
    op: "set" as const,
    path: `/${field}`,
    value,
  }))

  // Use Cosmos DB patch to atomically set fields — avoids race conditions
  // when multiple beat outputs are saved concurrently.
  try {
    await container.item(id, email).patch(ops)
    return
  } catch (e: unknown) {
    const code = (e as { code?: number | string })?.code
    if (code !== 404 && code !== "NotFound") throw e
  }

  // Item not found with given email — query by id across partitions
  const { resources } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: id }],
    })
    .fetchAll()

  if (resources.length > 0) {
    const doc = resources[0]
    await container.item(id, doc.email).patch(ops)
    return
  }

  // Document truly doesn't exist — create a recovery row with the ORIGINAL serial number
  console.warn(`[cosmos-db] updateUserFields: no document found for id=${id}, creating recovery row`)
  const newDoc: Record<string, string> = {
    id,
    firstName,
    email,
    audience: "",
    question1: "",
    question2: "",
    question3: "",
    question4: "",
    question5: "",
    question1_text: "",
    question2_text: "",
    question3_text: "",
    question4_text: "",
    question5_text: "",
    beat1_feedback: "",
    beat2_feedback: "",
    beat3_feedback: "",
    beat4_feedback: "",
    beat5_feedback: "",
    beat1_output: "",
    beat2_output: "",
    beat3_output: "",
    beat4_output: "",
    beat5_output: "",
    createdAt: new Date().toISOString(),
  }
  for (const [field, value] of fieldEntries) newDoc[field] = value
  await container.items.create(newDoc)
}

/** Backwards-compatible single-field setter. */
async function updateUserField(
  serialNumber: number,
  firstName: string,
  email: string,
  field: string,
  value: string
): Promise<void> {
  await updateUserFields(serialNumber, firstName, email, { [field]: value })
}

/**
 * Update a specific question field for the user with the given S.No.
 * Also persists the question text the user actually saw, so the answer remains
 * interpretable after the admin edits the prompt copy.
 */
export async function updateQuestionCell(
  serialNumber: number,
  firstName: string,
  email: string,
  questionNumber: number,
  answer: string,
  questionText?: string
): Promise<void> {
  const fields: Record<string, string> = {
    [`question${questionNumber}`]: answer,
  }
  if (typeof questionText === "string") {
    // Defence in depth — the API route already validates length, but if a
    // future caller bypasses that we still cap here.
    fields[`question${questionNumber}_text`] =
      questionText.length > MAX_QUESTION_TEXT_LEN
        ? questionText.slice(0, MAX_QUESTION_TEXT_LEN)
        : questionText
  }
  await updateUserFields(serialNumber, firstName, email, fields)
}

/**
 * Update the feedback field for a specific beat.
 */
export async function updateFeedbackCell(
  serialNumber: number,
  firstName: string,
  email: string,
  beatNumber: number,
  feedback: string
): Promise<void> {
  const field = `beat${beatNumber}_feedback`
  await updateUserField(serialNumber, firstName, email, field, feedback)
}

/**
 * Save the AI-generated beat output text.
 */
export async function updateBeatOutputCell(
  serialNumber: number,
  firstName: string,
  email: string,
  beatNumber: number,
  output: string
): Promise<void> {
  const field = `beat${beatNumber}_output`
  await updateUserField(serialNumber, firstName, email, field, output)
}

/**
 * Persist one or more final user-facing outputs (score / report / summary /
 * audio URL) onto the user document, so the admin can review exactly what a
 * tester received. Unknown keys are dropped defensively — only the four
 * whitelisted output columns can be written through here.
 */
export async function updateUserOutputs(
  serialNumber: number,
  firstName: string,
  email: string,
  outputs: Partial<Record<UserOutputField, string>>
): Promise<void> {
  const allowed: UserOutputField[] = [
    "offer_viewed_at",
    "score_json",
    "report_json",
    "summary_text",
    "summary_audio_url",
  ]
  const fields: Record<string, string> = {}
  for (const key of allowed) {
    const value = outputs[key]
    if (typeof value === "string" && value.length > 0) fields[key] = value
  }
  await updateUserFields(serialNumber, firstName, email, fields)
}

/** Persist the tester's PostHog session/distinct id so /techadmin can link a
 *  response straight to its session recording. */
export async function updateUserTelemetry(
  serialNumber: number,
  firstName: string,
  email: string,
  telemetry: { ph_session_id?: string; ph_distinct_id?: string }
): Promise<void> {
  const fields: Record<string, string> = {}
  if (telemetry.ph_session_id) fields.ph_session_id = telemetry.ph_session_id.slice(0, 200)
  if (telemetry.ph_distinct_id) fields.ph_distinct_id = telemetry.ph_distinct_id.slice(0, 200)
  await updateUserFields(serialNumber, firstName, email, fields)
}

/** The email and signup time on a user row, or null when there is no such
 *  serial. Read-only; used to tie a claimed serial to a claimed email before
 *  the paid-report unlock trusts it (see /api/stripe/verify-session). */
export async function readUserIdentity(
  serialNumber: number
): Promise<{ email: string; createdAt: string; paid_tier?: string } | null> {
  await ensureInitialized()
  const { resources } = await usersContainer()
    .items.query<{ email?: string; createdAt?: string; paid_tier?: string }>({
      query: "SELECT c.email, c.createdAt, c.paid_tier FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: String(serialNumber) }],
    })
    .fetchAll()
  const row = resources[0]
  if (!row?.email) return null
  return {
    email: row.email,
    createdAt: row.createdAt ?? "",
    ...(row.paid_tier ? { paid_tier: row.paid_tier } : {}),
  }
}

/**
 * Check Cosmos DB for a completed purchase by email.
 */
export async function readUserPurchaseByEmail(
  email: string
): Promise<{ paid_tier: string } | null> {
  await ensureInitialized()
  const normalized = email.trim().toLowerCase()
  if (!normalized) return null
  const { resources } = await usersContainer()
    .items.query<{ paid_tier?: string }>({
      query:
        "SELECT c.paid_tier FROM c WHERE (c.email = @email OR LOWER(c.email) = @email) AND IS_DEFINED(c.paid_tier) AND c.paid_tier != ''",
      parameters: [{ name: "@email", value: normalized }],
    })
    .fetchAll()
  const row = resources[0]
  if (!row?.paid_tier) return null
  return { paid_tier: row.paid_tier }
}

/** Record a completed purchase against the user document. */
export async function recordPurchase(
  serialNumber: number,
  firstName: string,
  email: string,
  purchase: { paid_tier: string; paid_amount?: string }
): Promise<void> {
  await updateUserFields(serialNumber, firstName, email, {
    paid_tier: purchase.paid_tier.slice(0, 40),
    paid_amount: (purchase.paid_amount ?? "").slice(0, 20),
    paid_at: new Date().toISOString(),
  })
}

/* ═══════════════════════════════════════════════
   Funnel analytics (/techadmin)
   ═══════════════════════════════════════════════ */

export interface FunnelStats {
  total: number
  stages: {
    signedUp: number
    answeredQ1: number
    answeredAll: number
    reachedBeats: number
    scored: number
    reported: number
    summarized: number
    purchased: number
  }
  byTier: Record<string, number>
  revenue: number
}

/**
 * Aggregate the whole users container into a funnel. Reads a thin projection
 * (not full documents) and counts in JS — fine for admin-panel volumes and far
 * simpler than a fan-out of COUNT queries. The "stages" are derived from data
 * we already store, so there's no separate page-tracking pipeline to maintain;
 * PostHog remains the source of truth for granular per-page paths.
 */
export async function fetchFunnelStats(): Promise<FunnelStats> {
  await ensureInitialized()
  const container = usersContainer()
  const { resources } = await container.items
    .query(
      // Answer presence is computed in Cosmos; the answer text is never read.
      `SELECT ${ANSWERED_PREDICATE("question1")} AS answered1, ${ANSWERED_PREDICATE("question5")} AS answered5, c.beat5_output, c.score_json, c.report_json, c.summary_text, c.paid_tier, c.paid_amount FROM c`
    )
    .fetchAll()

  const rows = resources ?? []
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0

  const stages = {
    signedUp: rows.length,
    answeredQ1: 0,
    answeredAll: 0,
    reachedBeats: 0,
    scored: 0,
    reported: 0,
    summarized: 0,
    purchased: 0,
  }
  const byTier: Record<string, number> = {}
  let revenue = 0

  for (const r of rows) {
    if (r.answered1 === true) stages.answeredQ1++
    if (r.answered5 === true) stages.answeredAll++
    if (nonEmpty(r.beat5_output)) stages.reachedBeats++
    if (nonEmpty(r.score_json)) stages.scored++
    if (nonEmpty(r.report_json)) stages.reported++
    if (nonEmpty(r.summary_text)) stages.summarized++
    if (nonEmpty(r.paid_tier)) {
      stages.purchased++
      const tier = String(r.paid_tier)
      byTier[tier] = (byTier[tier] ?? 0) + 1
      const amt = Number.parseFloat(String(r.paid_amount ?? ""))
      if (Number.isFinite(amt)) revenue += amt
    }
  }

  return { total: rows.length, stages, byTier, revenue }
}
