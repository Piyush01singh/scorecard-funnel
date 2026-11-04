import {
  buildSystemPrompt,
  buildUserPromptForBeat,
  getBeatSystemContext,
  type ChallengeResponses,
  type Gate2Resonance,
  type Gate4Tone,
} from "@/lib/server/challenge-prompts"
import { redactError } from "@/lib/security"
import { DEFAULT_VERTICAL, normalizeVertical } from "@/lib/verticals"
import { z } from "zod"

const bodySchema = z.object({
  beatNumber: z.number().int().min(1).max(5),
  audience: z
    .string()
    .transform((v) => normalizeVertical(v) ?? DEFAULT_VERTICAL),
  firstName: z.string().max(200).optional().default(""),
  responses: z.object({
    question1: z.string().max(1500).optional().default(""),
    question2: z.string().max(1500).optional().default(""),
    question3: z.string().max(1500).optional().default(""),
    question4: z.string().max(1500).optional().default(""),
    question5: z.string().max(1500).optional().default(""),
  }),
  gate2Resonance: z.enum(["HIGH", "MID", "LOW"]).optional(),
  gate4Tone: z.enum(["LANDED", "FAMILIAR", "DISTANT"]).optional(),
})

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

function sseData(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`)
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim()
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: "Validation failed", details: parsed.error.flatten() }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }

  const { beatNumber, audience, firstName, responses, gate2Resonance, gate4Tone } = parsed.data
  const resPayload: ChallengeResponses = {
    question1: responses.question1,
    question2: responses.question2,
    question3: responses.question3,
    question4: responses.question4,
    question5: responses.question5,
  }

  const g2: Gate2Resonance = gate2Resonance ?? "MID"
  const g4: Gate4Tone = gate4Tone ?? "FAMILIAR"

  let system: string
  let user: string
  let beatContext: string
  try {
    system = await buildSystemPrompt(audience, firstName, resPayload)
    // resPayload is passed to both so any [VAR_Qn] token in admin-authored beat
    // copy is resolved server-side rather than left for the model to infer.
    user = await buildUserPromptForBeat(audience, beatNumber as 1 | 2 | 3 | 4 | 5, g2, g4, resPayload)
    beatContext = await getBeatSystemContext(audience, beatNumber as 1 | 2 | 3 | 4 | 5, resPayload)
  } catch (e) {
    console.error("[stream-beat] prompt build", redactError(e))
    const message = e instanceof Error ? e.message : "Prompt configuration error"
    // Surface a clear "not configured" error so the client can render an empty state
    // when team prompts haven't been seeded yet.
    return new Response(
      JSON.stringify({ error: "Prompt configuration error", detail: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }

  const model =
    process.env.OPENROUTER_MODEL?.trim() || "openai/gpt-4o-mini"
  const referer =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://localhost:3000"

  let upstream: Response
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": "Belief Score",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: beatContext ? `${beatContext}\n\n${system}` : system },
          { role: "user", content: user },
        ],
        stream: true,
        temperature: 0.65,
        max_tokens: 4096,
      }),
    })
  } catch (e) {
    console.error("[stream-beat] upstream fetch", redactError(e))
    return new Response(JSON.stringify({ error: "Upstream service error" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    })
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "")
    console.error("[stream-beat] upstream status", upstream.status, errText.slice(0, 500))
    return new Response(
      JSON.stringify({ error: "Upstream service error", status: upstream.status }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    )
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sseBuffer = ""
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sseBuffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = sseBuffer.indexOf("\n\n")) !== -1) {
            const block = sseBuffer.slice(0, idx)
            sseBuffer = sseBuffer.slice(idx + 2)
            for (const line of block.split("\n")) {
              const trimmed = line.trim()
              if (!trimmed.startsWith("data:")) continue
              const data = trimmed.slice(5).trim()
              if (data === "[DONE]") continue
              try {
                const j = JSON.parse(data) as {
                  choices?: Array<{ delta?: { content?: string } }>
                }
                const content = j.choices?.[0]?.delta?.content
                if (content) {
                  controller.enqueue(sseData({ c: content }))
                }
              } catch {
                /* ignore */
              }
            }
          }
        }
        // Flush any trailing data left in the buffer after the stream ends.
        // The last chunk from OpenRouter may not end with \n\n.
        const trailing = sseBuffer.trim()
        if (trailing) {
          for (const line of trailing.split("\n")) {
            const trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            const data = trimmed.slice(5).trim()
            if (data === "[DONE]") continue
            try {
              const j = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>
              }
              const content = j.choices?.[0]?.delta?.content
              if (content) {
                controller.enqueue(sseData({ c: content }))
              }
            } catch {
              /* ignore */
            }
          }
        }
      } finally {
        controller.enqueue(sseData({ done: true }))
        controller.close()
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
