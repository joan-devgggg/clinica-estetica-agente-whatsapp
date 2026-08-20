/**
 * /reservar/[slug] — El enlace público de reserva. La única pantalla del sistema que abre
 * alguien SIN sesión.
 *
 * Vive fuera del grupo `(app)`, así que no hereda su layout: ni barra lateral, ni
 * `OrgProvider`, ni `BotStatusProvider` — nada de eso tiene sentido sin usuario, y varias de
 * esas piezas piden al panel, que respondería 401. Lo único que hereda es el layout raíz
 * (tipografías y tokens de color).
 *
 * `proxy.ts` ya deja pasar `/reservar/` y `/api/reservar/` sin sesión; sin esa exención la
 * clienta acabaría en la pantalla de acceso del panel del salón.
 *
 * El `slug` NO se valida aquí: quién existe y quién es un salón lo decide `resolveOrgBySlug`
 * en Express, y su «no» es un 404 idéntico para un slug inventado, para San Remo y para un
 * secreto equivocado. Comprobarlo también aquí obligaría a mantener dos listas de orgs, y la
 * de esta app se quedaría vieja.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { FormularioReserva } from "@/components/reservar/formulario-reserva";
import { elegirIdioma, textos } from "@/lib/reservar/nucleo";

/**
 * El título de la PESTAÑA también va en su idioma: es lo que la clienta ve en la lista de
 * pestañas y lo que se guarda si añade el enlace a la pantalla de inicio. Se resuelve con la
 * misma cascada que la página, así que no puede decir una cosa y la pantalla otra.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const cabeceras = await headers();
  const { idioma } = elegirIdioma({ url: sp.lang, aceptaIdiomas: cabeceras.get("accept-language") });
  return {
    title: textos(idioma).titulo,
    // Fuera del índice mientras el enlace no esté decidido: se pega en la bio de Instagram y
    // en Google Business, que es donde tiene que estar, y no en una búsqueda que lleve al
    // subdominio del panel del salón. Se quita cuando se quiera (decisión del dueño, 21/08).
    robots: { index: false, follow: false },
  };
}

export default async function PaginaReservar({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  // El idioma se resuelve AQUÍ, en el servidor, y llega ya elegido al componente: así el
  // primer HTML sale en el idioma bueno y no hay un parpadeo de castellano. La cascada
  // —URL, luego navegador, luego castellano— vive en `elegirIdioma`, que es puro y está
  // probado; esta función solo le da las dos entradas.
  //
  // Leer `headers()` hace la página dinámica, y ya lo era: `searchParams` la obliga igual, y
  // la disponibilidad de una agenda viva no se cachea.
  const cabeceras = await headers();
  const { idioma } = elegirIdioma({
    url: sp.lang,
    aceptaIdiomas: cabeceras.get("accept-language"),
  });

  return <FormularioReserva slug={slug} lang={idioma} />;
}
