/**
 * Character length limits for Text-To-Speech (TTS) synthesis (/api/tts).
 *
 * Enforcing a maximum limit prevents unauthenticated abuse and economic DoS
 * on paid voice synthesis providers (ElevenLabs charges per character,
 * xAI Grok charges per request/character).
 */
export const MAX_TTS_CHARS = 500

export function isValidTtsLength(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_TTS_CHARS
}
