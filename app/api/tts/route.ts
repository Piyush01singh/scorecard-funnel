import { ElevenLabsClient } from "elevenlabs";
import { NextRequest, NextResponse } from "next/server";
import { MAX_TTS_CHARS } from "@/lib/tts-limits";

type Provider = "xai" | "elevenlabs";

// Default provider when the client doesn't specify one. Per-request `provider`
// in the POST body (e.g. "xai" for beat reveals, "elevenlabs" for the final
// summary) overrides this.
const DEFAULT_PROVIDER: Provider =
  (process.env.TTS_PROVIDER || "xai").toLowerCase() === "elevenlabs"
    ? "elevenlabs"
    : "xai";

// Abuse protection: in-memory per-IP sliding window rate limiter
// protects paid endpoints against automated floods when Redis is unavailable.
const ttsRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const TTS_RATE_LIMIT_WINDOW_MS = 60_000;
const TTS_RATE_LIMIT_MAX_REQUESTS = 30;

function isTtsRateLimited(ip: string): boolean {
  if (ip === "unknown") return false;
  const now = Date.now();
  const entry = ttsRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ttsRateLimitMap.set(ip, { count: 1, resetAt: now + TTS_RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > TTS_RATE_LIMIT_MAX_REQUESTS;
}

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

    if (isTtsRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }

    let body: {
      beatContent?: unknown;
      text?: unknown;
      provider?: unknown;
    };

    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
    }

    const rawText =
      typeof body.beatContent === "string"
        ? body.beatContent
        : typeof body.text === "string"
          ? body.text
          : undefined;

    if (!rawText || !rawText.trim() || rawText.length > MAX_TTS_CHARS) {
      return NextResponse.json(
        { error: `Valid text (max ${MAX_TTS_CHARS} characters) is required` },
        { status: 400 }
      );
    }

    const trimmedText = rawText.trim();

    if (body.provider !== undefined && body.provider !== "elevenlabs" && body.provider !== "xai") {
      return NextResponse.json(
        { error: "Invalid provider. Supported providers are 'xai' and 'elevenlabs'" },
        { status: 400 }
      );
    }

    const provider: Provider =
      body.provider === "elevenlabs" || body.provider === "xai"
        ? (body.provider as Provider)
        : DEFAULT_PROVIDER;

    if (provider === "elevenlabs") {
      return await elevenLabsTts(trimmedText);
    }

    return await xaiGrokTts(trimmedText);

  } catch (error) {
    console.error('TTS error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function xaiGrokTts(text: string): Promise<NextResponse> {
  const apiKey = process.env.XAI_API_KEY;
  const voiceId = process.env.XAI_TTS_VOICE_ID || "eve";
  const language = process.env.XAI_TTS_LANGUAGE || "en";

  if (!apiKey) {
    console.warn("xAI API key is missing");
    return NextResponse.json({ error: 'xAI API key not configured' }, { status: 500 });
  }

  const res = await fetch("https://api.x.ai/v1/tts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      language,
      voice_id: voiceId,
      output_format: {
        codec: "mp3",
        sample_rate: 24000,
        bit_rate: 128000,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[TTS API] xAI request failed: ${res.status} ${res.statusText} ${errBody}`);
    return NextResponse.json({ error: `xAI TTS failed: ${res.status}` }, { status: 502 });
  }

  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  console.log(`[TTS API] Generated buffer: ${buffer.length} bytes, provider: xai, voiceId: ${voiceId}`);

  if (buffer.length === 0) {
    console.error("[TTS API] xAI returned an empty audio buffer!");
    return NextResponse.json({ error: "Empty audio returned from xAI" }, { status: 502 });
  }

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": buffer.length.toString(),
    },
  });
}

// ElevenLabs path. Used for the journey summary; also reachable for any
// other surface that sends `provider: "elevenlabs"`.
async function elevenLabsTts(text: string): Promise<NextResponse> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'cR39HTrtXbjvEP4CNYFx';
  const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

  // ElevenLabs accepts 0.7–1.2; <1 slows speech, >1 speeds it up. Default
  // 0.9 reads the summary at a calmer, more reflective pace.
  const rawSpeed = Number.parseFloat(process.env.ELEVENLABS_VOICE_SPEED || "0.9");
  const speed = Number.isFinite(rawSpeed)
    ? Math.min(1.2, Math.max(0.7, rawSpeed))
    : 0.9;

  if (!apiKey) {
    console.warn("ElevenLabs API key is missing");
    return NextResponse.json({ error: 'ElevenLabs API key not configured' }, { status: 500 });
  }

  const client = new ElevenLabsClient({ apiKey });

  const audioStream = await client.textToSpeech.convert(voiceId, {
    text,
    model_id: modelId,
    output_format: "mp3_44100_128",
    voice_settings: { speed },
  });

  const chunks: Buffer[] = [];
  for await (const chunk of audioStream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  console.log(`[TTS API] Generated buffer: ${buffer.length} bytes, provider: elevenlabs, voiceId: ${voiceId}, model: ${modelId}`);

  if (buffer.length === 0) {
    console.error("[TTS API] ElevenLabs returned an empty audio buffer!");
    return NextResponse.json({ error: "Empty audio returned from ElevenLabs" }, { status: 502 });
  }

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": buffer.length.toString(),
    },
  });
}
