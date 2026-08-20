/**
 * error.tsx — La última red de la pantalla pública: que NUNCA se quede en blanco.
 *
 * Todo lo que falla por la RED ya lo recoge el formulario con su conjunto cerrado de
 * motivos. Esto es para lo otro: que algo reviente al pintar. Sin este fichero, React
 * desmonta el árbol y la clienta se queda mirando una página vacía — o, en desarrollo, un
 * error en inglés con una traza dentro.
 *
 * No dice qué ha pasado. Un mensaje de excepción puede llevar nombres de fichero, de tabla o
 * un trozo de dato; y a quien está pidiendo hora no le sirve de nada.
 */
"use client";

import { RefreshCw } from "lucide-react";
import { elegirIdioma, textos } from "@/lib/reservar/nucleo";

export default function ErrorReserva({ reset }: { error: Error; reset: () => void }) {
  // Aquí no llegan props: este componente lo monta React cuando el árbol ya se ha caído. Pero
  // el idioma sí se puede recuperar, y hay que hacerlo — una pantalla de avería en castellano
  // para una clienta rusa es el peor momento posible para cambiar de idioma. Misma cascada que
  // la página: la URL que ella eligió, luego el navegador, luego castellano.
  const { idioma } = elegirIdioma(
    typeof window === "undefined"
      ? {}
      : {
          url: new URLSearchParams(window.location.search).get("lang"),
          aceptaIdiomas: (navigator.languages ?? [navigator.language]).join(","),
        },
  );
  const t = textos(idioma);
  const texto = t.motivos.error_interno;

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center px-4">
      <div className="rounded-2xl border border-primary/25 bg-primary/5 p-5">
        <p className="font-heading text-lg font-semibold">{texto.titulo}</p>
        <p className="mt-1 text-sm text-muted-foreground">{texto.cuerpo}</p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 inline-flex min-h-12 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground"
        >
          <RefreshCw className="size-4" />
          {t.reintentar}
        </button>
      </div>
    </div>
  );
}
