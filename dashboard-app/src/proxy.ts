import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/utils/supabase/middleware";

// Las dos formas de la superficie pública, y solo esas dos: la página y sus endpoints.
// Se comprueban con un ancla al principio de la ruta (`/reservar/` y `/api/reservar/`) y no
// con un `includes`, que dejaría pasar cualquier ruta del panel que llevara esa palabra
// dentro. `/reservar` a secas queda fuera: sin salón no hay nada público que enseñar.
function esRutaPublicaDeReserva(pathname: string): boolean {
  return pathname.startsWith("/reservar/") || pathname.startsWith("/api/reservar/");
}

export async function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEV_SKIP_AUTH === "true") {
    return NextResponse.next();
  }

  const { supabase, response } = createClient(request);

  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // El enlace PÚBLICO de reserva no tiene sesión: es su razón de ser. Sin esta exención,
  // el matcher de abajo —que atrapa TODO menos los estáticos— redirigiría a `/login` tanto
  // la página como sus endpoints, y la clienta acabaría en la pantalla de acceso del panel
  // del salón. Es el aviso que ya estaba escrito en el brief («cuidado con proxy.ts»).
  //
  // La exención es de AUTENTICACIÓN y de nada más: quién puede reservar, cuántas veces y con
  // qué límites lo deciden Express y Postgres, no este fichero.
  if (esRutaPublicaDeReserva(pathname)) {
    return NextResponse.next();
  }

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
