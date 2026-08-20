/**
 * reserva-web.ts — El puente SERVIDOR→SERVIDOR del enlace público de reserva.
 *
 * Lo usan solo los Route Handlers de `src/app/api/reservar/[slug]/*`, que corren en el
 * servidor de Next. El navegador de la clienta llama a ESE Next, nunca a Express.
 *
 * ── Por qué existe esta capa y no un fetch directo desde el navegador ────────────────────
 *
 *  1. **No hay que abrir el CORS de Express a un origen público.** La allowlist de
 *     `webhook.js` sigue teniendo dentro solo al panel. Una petición de servidor no es una
 *     petición de navegador y no pasa por CORS.
 *  2. **El secreto no sale de aquí.** `RESERVA_WEB_TOKEN` NO lleva el prefijo
 *     `NEXT_PUBLIC_`, y eso no es estilo: en Next, todo lo `NEXT_PUBLIC_` se inlinea en el
 *     bundle que se descarga el navegador. Con ese prefijo, el secreto estaría en el
 *     código fuente de la página para cualquiera que abra las herramientas de desarrollo.
 *  3. **La URL de Railway no aparece en el HTML de nadie.**
 *
 * ── Y por qué el rate limit NO vive aquí ─────────────────────────────────────────────────
 *
 * Este fichero corre en Vercel, que es serverless: cada invocación puede caer en una
 * instancia nueva y no hay memoria compartida entre ellas. Un contador en RAM aquí no cuenta
 * nada — daría una sensación de protección que no existe. El limitador vive en Express
 * (Railway), que es UN proceso largo, y el tope de citas por clienta vive en Postgres.
 * Ver la cabecera de `services/reserva-web.js`.
 */
import { NextResponse, type NextRequest } from "next/server";

const API = process.env.API_URL_INTERNO ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const TOKEN = process.env.RESERVA_WEB_TOKEN ?? "";

/**
 * La IP de la clienta, para que Express pueda limitar por ella.
 *
 * Sin esto, Express vería siempre la IP de Vercel y las clientas compartirían un solo cupo:
 * la primera en reservar dejaría fuera a todas las demás durante una hora.
 *
 * Se usa la cabecera que pone la propia plataforma (`x-forwarded-for`), y se coge el PRIMER
 * valor, que es el cliente original. Aquí sí se puede confiar en ella porque la escribe el
 * proxy de Vercel por delante de nuestro código; lo que no se puede es confiar en ella en
 * Express, y por eso allí solo se lee cuando la petición ya ha probado el secreto.
 */
function ipDeLaClienta(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const primera = xff.split(",")[0]?.trim();
  return primera || req.headers.get("x-real-ip") || "";
}

type Respuesta = { estado: number; cuerpo: unknown };

async function llamar(
  req: NextRequest,
  ruta: string,
  init: { method: "GET" | "POST"; body?: string; query?: URLSearchParams },
): Promise<Respuesta> {
  // Sin secreto configurado no se llama a nada: se responde como si la página no existiera,
  // igual que hace Express. Un despliegue a medias se queda CERRADO, nunca abierto.
  if (!TOKEN) {
    return { estado: 404, cuerpo: { ok: false, motivo: "no_encontrado" } };
  }
  const url = `${API}${ruta}${init.query && [...init.query].length ? `?${init.query}` : ""}`;
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        "X-Reserva-Token": TOKEN,
        "X-Cliente-IP": ipDeLaClienta(req),
      },
      body: init.body,
      // Disponibilidad de una agenda viva: una respuesta cacheada enseñaría huecos que ya
      // no existen, y ese es justo el fallo que este proyecto no puede permitirse.
      cache: "no-store",
    });
    const texto = await res.text();
    let cuerpo: unknown;
    try {
      cuerpo = texto ? JSON.parse(texto) : null;
    } catch {
      // Express caído devolviendo HTML de error. NO se reenvía tal cual: podría llevar una
      // traza. Se traduce a un motivo del conjunto cerrado, MARCADO como propio: este «no»
      // no ha pasado por la política de `services/reserva-web.js`, así que no lleva el
      // WhatsApp que esa política le daría, y la pantalla tiene que poder saberlo para poner
      // el suyo de respaldo. Sin la marca, el aviso dice «escríbenos» y no hay a dónde.
      return { estado: 502, cuerpo: { ok: false, motivo: "error_interno", origen: "puente" } };
    }
    return { estado: res.status, cuerpo };
  } catch {
    // Red caída entre Vercel y Railway. La clienta no tiene por qué leer eso.
    return { estado: 502, cuerpo: { ok: false, motivo: "error_interno", origen: "puente" } };
  }
}

/** Reenvía una LECTURA, copiando solo los parámetros que el endpoint entiende. */
export async function leer(
  req: NextRequest,
  slug: string,
  recurso: "catalogo" | "dias" | "huecos",
  permitidos: string[],
): Promise<NextResponse> {
  const entrada = req.nextUrl.searchParams;
  // Allowlist de parámetros: lo que no está aquí no viaja. Reenviar la query entera dejaría
  // que cualquiera probara parámetros contra la API interna a través de nuestra propia
  // página.
  const query = new URLSearchParams();
  for (const clave of permitidos) {
    const v = entrada.get(clave);
    if (v !== null) query.set(clave, v.slice(0, 200));
  }
  const { estado, cuerpo } = await llamar(req, `/reserva-web/${encodeURIComponent(slug)}/${recurso}`, {
    method: "GET",
    query,
  });
  return NextResponse.json(cuerpo, { status: estado });
}

/** Reenvía la RESERVA. */
export async function reservar(req: NextRequest, slug: string): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, motivo: "datos_invalidos" }, { status: 400 });
  }
  const { estado, cuerpo } = await llamar(req, `/reserva-web/${encodeURIComponent(slug)}/reserva`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return NextResponse.json(cuerpo, { status: estado });
}
