import { NextResponse } from "next/server"
import {
  corsHeaders,
  createAdminSessionToken,
  buildAdminSessionCookie,
  timingSafeMatch,
} from "@/lib/server/admin-auth"

/** CORS preflight */
export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * POST /api/admin/login
 *
 * Verifies the admin or tech-admin password and sets an HttpOnly SameSite
 * session cookie on success. Eliminates storing plaintext passwords in the browser.
 */
export async function POST(request: Request) {
  const headers = new Headers(corsHeaders(request))
  let body: { password?: string; scope?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore
  }

  const password = (
    typeof body.password === "string"
      ? body.password
      : request.headers.get("x-admin-password") ?? ""
  ).trim()

  const scope = (
    body.scope === "tech" ||
    new URL(request.url).searchParams.get("scope") === "tech"
  )
    ? "tech"
    : "admin"

  let role: "admin" | "tech" | null = null

  if (scope === "tech") {
    if (timingSafeMatch(password, process.env.TECHADMIN_API_PASSWORD)) {
      role = "tech"
    }
  } else {
    // Regular admin scope allows techadmin password as well (superset role)
    if (timingSafeMatch(password, process.env.TECHADMIN_API_PASSWORD)) {
      role = "tech"
    } else if (timingSafeMatch(password, process.env.ADMIN_API_PASSWORD)) {
      role = "admin"
    }
  }

  if (!role) {
    return NextResponse.json(
      { ok: false, error: "Invalid password" },
      { status: 401, headers }
    )
  }

  const token = createAdminSessionToken(role)
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Authentication configuration error" },
      { status: 500, headers }
    )
  }

  headers.append("Set-Cookie", buildAdminSessionCookie(token))
  return NextResponse.json({ ok: true, role }, { status: 200, headers })
}
