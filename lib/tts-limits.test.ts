// Run with: npm test

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { MAX_TTS_CHARS, isValidTtsLength } from "@/lib/tts-limits"

test("TTS character limit is 500 characters", () => {
  assert.equal(MAX_TTS_CHARS, 500)
  assert.equal(isValidTtsLength(""), false)
  assert.equal(isValidTtsLength("   "), false)
  assert.equal(isValidTtsLength(null), false)
  assert.equal(isValidTtsLength(undefined), false)
  assert.equal(isValidTtsLength("a".repeat(500)), true)
  assert.equal(isValidTtsLength("a".repeat(501)), false)
})

test("/api/tts enforces character length limits and rejects oversized requests", async () => {
  const src = await readFile(new URL("../app/api/tts/route.ts", import.meta.url), "utf8")
  assert.match(src, /MAX_TTS_CHARS/)
  assert.match(src, /rawText\.length\s*>\s*MAX_TTS_CHARS/)
  assert.match(src, /Valid text \(max \$\{MAX_TTS_CHARS\} characters\) is required/)
})

test("/api/tts validates required text and rejects empty payloads", async () => {
  const src = await readFile(new URL("../app/api/tts/route.ts", import.meta.url), "utf8")
  assert.match(src, /!rawText\s*\|\|\s*!rawText\.trim\(\)/)
})

test("/api/tts accepts beatContent and text as alias parameters", async () => {
  const src = await readFile(new URL("../app/api/tts/route.ts", import.meta.url), "utf8")
  assert.match(src, /typeof body\.beatContent === "string"/)
  assert.match(src, /typeof body\.text === "string"/)
})

test("/api/tts validates providers and includes abuse rate limiting", async () => {
  const src = await readFile(new URL("../app/api/tts/route.ts", import.meta.url), "utf8")
  assert.match(src, /body\.provider !== "elevenlabs" && body\.provider !== "xai"/)
  assert.match(src, /isTtsRateLimited/)
  assert.match(src, /Too many requests\. Please try again later\./)
})

test("frontend audio caches clamp text to MAX_TTS_CHARS to preserve normal use", async () => {
  const beatCacheSrc = await readFile(new URL("./client/beat-audio-cache.ts", import.meta.url), "utf8")
  assert.match(beatCacheSrc, /MAX_TTS_CHARS/)
  assert.match(beatCacheSrc, /slice\(0,\s*MAX_TTS_CHARS\)/)

  const summaryCacheSrc = await readFile(new URL("./client/summary-audio-cache.ts", import.meta.url), "utf8")
  assert.match(summaryCacheSrc, /MAX_TTS_CHARS/)
  assert.match(summaryCacheSrc, /slice\(0,\s*MAX_TTS_CHARS\)/)
})
