import { type NextRequest } from "next/server";
import { reservar } from "@/lib/reserva-web";

// La reserva. Todo lo que decide —topes, lista negra, claim atómico— vive en Express y en
// Postgres; aquí solo se reenvía y se devuelve el motivo tal cual, que es de conjunto
// cerrado y la página sabe traducir.
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return reservar(req, slug);
}
