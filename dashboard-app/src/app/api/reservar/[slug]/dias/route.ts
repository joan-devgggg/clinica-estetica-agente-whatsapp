import { type NextRequest } from "next/server";
import { leer } from "@/lib/reserva-web";

// Qué días del horizonte tienen algún hueco: lo que necesita la rejilla del mes.
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return leer(req, slug, "dias", ["servicio", "estilista", "lang"]);
}
