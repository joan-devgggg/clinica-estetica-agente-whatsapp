import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/middleware";

export async function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === "true") {
    return NextResponse.next();
  }

  const { supabase, response } = createClient(request);

  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && !pathname.startsWith("/login") && !pathname.startsWith("/api/auth")) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  if (user && pathname.startsWith("/login")) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    return NextResponse.redirect(homeUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
