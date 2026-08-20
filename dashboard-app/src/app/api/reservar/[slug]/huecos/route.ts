import { type NextRequest } from "next/server";
import { leer } from "@/lib/reserva-web";

// Las horas libres de UN día concreto.
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return leer(req, slug, "huecos", ["servicio", "fecha", "estilista", "lang"]);
}
