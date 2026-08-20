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
import { FormularioReserva } from "@/components/reservar/formulario-reserva";

export const metadata: Metadata = {
  title: "Pedir cita",
  description: "Reserva tu cita en unos toques.",
  // Fuera del índice mientras el enlace no esté decidido: se pega en la bio de Instagram y
  // en Google Business, que es donde tiene que estar, y no en una búsqueda que lleve al
  // subdominio del panel del salón. Se quita cuando se quiera (decisión del dueño, 21/08).
  robots: { index: false, follow: false },
};

export default async function PaginaReservar({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  // El idioma entra por la URL (`?lang=en`). Hoy solo hay castellano y cualquier otro valor
  // cae ahí dentro; el día que se traduzca, el enlace de cada idioma ya funciona sin tocar
  // ni un componente.
  const lang = typeof sp.lang === "string" ? sp.lang : "es";

  return <FormularioReserva slug={slug} lang={lang} />;
}
