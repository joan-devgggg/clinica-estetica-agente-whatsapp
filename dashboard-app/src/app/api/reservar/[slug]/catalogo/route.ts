import { type NextRequest } from "next/server";
import { leer } from "@/lib/reserva-web";

// El catálogo que puede reservarse sola una clienta: sin inactivos, sin complementos y sin
// la Consulta de valoración. Quien decide eso es Express — aquí no se filtra nada, para que
// no haya dos criterios de qué se ofrece.
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return leer(req, slug, "catalogo", ["lang"]);
}
