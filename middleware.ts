import { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/cron/")) {
    const cronSecret = request.headers.get("x-cron-secret");

    if (cronSecret && !request.headers.has("authorization")) {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${cronSecret}`);
      headers.delete("x-cron-secret");
      request = new NextRequest(request, { headers });
    }
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
