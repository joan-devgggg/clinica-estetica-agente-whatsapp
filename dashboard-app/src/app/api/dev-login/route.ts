import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const DEV_USERS: Record<string, string> = {
  sante: "joan.gasconp@gmail.com",
  sanremo: "joan.gasconp+sanremo@gmail.com",
};

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const org = request.nextUrl.searchParams.get("org");
  const email = org ? DEV_USERS[org] : null;
  if (!email) {
    return NextResponse.json(
      { error: "Use ?org=sante or ?org=sanremo" },
      { status: 400 },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

  const admin = createAdminClient(supabaseUrl, serviceRoleKey);

  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email });

  if (linkError || !linkData?.properties?.hashed_token) {
    return NextResponse.json(
      { error: "Failed to generate link", details: linkError?.message },
      { status: 500 },
    );
  }

  const tokenHash = linkData.properties.hashed_token;

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options),
        );
      },
    },
  });

  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: "email",
  });

  if (verifyError) {
    return NextResponse.json(
      { error: "Failed to verify", details: verifyError.message },
      { status: 500 },
    );
  }

  return NextResponse.redirect(new URL("/", request.url));
}
