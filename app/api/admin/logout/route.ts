import { NextResponse } from "next/server"
import { corsHeaders, buildAdminLogoutCookie } from "@/lib/server/admin-auth"

/** CORS preflight */
export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * POST /api/admin/logout
 *
 * Clears the HttpOnly admin session cookie.
 */
export async function POST(request: Request) {
  const headers = new Headers(corsHeaders(request))
  headers.append("Set-Cookie", buildAdminLogoutCookie())
  return NextResponse.json({ ok: true }, { status: 200, headers })
}
