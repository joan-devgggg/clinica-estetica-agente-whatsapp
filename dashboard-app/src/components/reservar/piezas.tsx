/**
 * piezas.tsx — Lo que se VE del enlace público de reserva.
 *
 * Componentes sin estado: reciben lo que tienen que pintar y avisan de lo que se ha tocado.
 * Toda la decisión vive en `formulario-reserva.tsx` (la máquina) y en `lib/reservar/nucleo.ts`
 * (lo que se puede probar sin React). Aquí no se decide nada, y eso es a propósito: es la
 * única capa que un test de Node no puede ejecutar.
 *
 * ── Se ve en un MÓVIL, y probablemente con una mano ─────────────────────────────────────
 *
 * De ahí tres cosas que no son estética:
 *   · nada por debajo de 44 px de alto tocable — el botón de 32 px del panel (`ui/button`)
 *     está pensado para un ratón, y por eso esta pantalla no lo usa;
 *   · la acción principal vive ABAJO, al alcance del pulgar, no arriba;
 *   · una sola columna y una sola decisión por pantalla.
 */
"use client";

import { useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Globe, LoaderCircle, MessageCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type Casilla,
  type EntradaCatalogo,
  type Idioma,
  type Fallo,
  type GrupoServicio,
  type Mes,
  type Pais,
  type ProblemaTelefono,
  type Salon,
  type Textos,
  IDIOMAS,
  NOMBRES_IDIOMA,
  enlaceDelAviso,
  etiquetaMes,
  formatearDuracion,
  formatearPrecio,
  nombrePais,
  prefijoVisible,
  rellenar,
  textoDelAviso,
  textoEspera,
} from "@/lib/reservar/nucleo";

// ─── Chrome: cabecera, progreso, esqueleto ───────────────────────────────────────────────

export function Cabecera({
  t, salon, atras, paso, total, idioma, cambiarIdioma,
}: {
  t: Textos;
  salon: string | null;
  atras: (() => void) | null;
  paso: number | null;
  total: number;
  idioma: Idioma;
  cambiarIdioma: (i: Idioma) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  return (
    <header className="sticky top-0 z-10 -mx-4 mb-5 border-b border-border/60 bg-background/95 px-4 pt-3 pb-3 backdrop-blur">
      <div className="flex min-h-11 items-center gap-2">
        {atras ? (
          <button
            type="button"
            onClick={atras}
            aria-label={t.volver}
            className="-ml-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted active:bg-muted"
          >
            <ArrowLeft className="size-5" />
          </button>
        ) : (
          <span className="size-11 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-base leading-tight font-semibold">
            {salon ?? t.titulo}
          </p>
          {paso !== null && (
            <p className="text-xs text-muted-foreground">
              {t.paso} {paso} {t.de} {total}
            </p>
          )}
        </div>
        {/* ── El selector de idioma ────────────────────────────────────────────────────
            Era un círculo con «ES» dentro y nada más: no se leía como un botón, y desde
            luego no decía que sirviera para cambiar de idioma. Ahora lleva las tres cosas
            que lo convierten en un control — un globo, un borde y un galón —, y el código
            de dos letras se queda porque es lo que dice cuál está puesto.

            El globo y NO una bandera: una bandera dice país, no idioma, y este ruso lo lee
            tanto quien vive en Ucrania como quien no. Es la misma decisión de antes, ahora
            con un icono que sí significa «idioma».

            El `aria-label` cambia también, y era la mitad del bug para quien usa lector de
            pantalla: decía «Español», o sea lo que está ELEGIDO, y no lo que pasa si lo
            tocas. Ahora dice las dos cosas.

            Cuesta unos 30 px de ancho, y salen del título, que ya truncaba. No cuesta una
            fila ni empuja nada hacia abajo: la cabecera mide exactamente lo mismo. */}
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          aria-expanded={abierto}
          aria-label={`${t.idioma}: ${NOMBRES_IDIOMA[idioma]}`}
          className={cn(
            "flex h-11 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold tracking-wide uppercase transition-colors",
            abierto ? "border-primary/40 bg-primary/5 text-primary" : "border-border bg-card text-muted-foreground hover:bg-muted",
          )}
        >
          <Globe className="size-4" />
          {idioma}
          <ChevronDown className={cn("size-3.5 transition-transform", abierto && "rotate-180")} />
        </button>
      </div>

      {/* Se abre DEBAJO y a lo ancho: cuatro dianas de 44 px no caben en la fila del título a
          375 px, y el idioma se elige una vez. */}
      {abierto && (
        <ul className="mt-2 flex flex-col gap-1 rounded-2xl border border-border bg-card p-1">
          {IDIOMAS.map((i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => { setAbierto(false); cambiarIdioma(i); }}
                aria-current={i === idioma ? "true" : undefined}
                className={cn(
                  "min-h-11 w-full rounded-xl px-3 text-left text-sm",
                  i === idioma ? "bg-primary/10 font-semibold text-primary" : "hover:bg-muted",
                )}
              >
                {NOMBRES_IDIOMA[i]}
              </button>
            </li>
          ))}
        </ul>
      )}
      {paso !== null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${Math.round((paso / total) * 100)}%` }}
          />
        </div>
      )}
    </header>
  );
}

export function Titulo({ children }: { children: React.ReactNode }) {
  return <h1 className="mb-4 font-heading text-2xl leading-snug font-semibold">{children}</h1>;
}

export function Cargando({ t }: { t: Textos }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground" role="status">
      <LoaderCircle className="size-6 animate-spin" />
      <span className="text-sm">{t.cargando}</span>
    </div>
  );
}

/**
 * La línea de debajo del nombre: qué es este servicio, en el idioma de la pantalla.
 *
 * ── EL NOMBRE NO SE TRADUCE, Y ESTO ES LO QUE LO HACE INNECESARIO ───────────────────────
 *
 * El nombre que la clienta lee aquí es EXACTAMENTE la cadena que se va a escribir en
 * `appointments.service`: la que el salón verá en la agenda, la que le dirá el recordatorio
 * de 24 h y contra la que casa la facturación (que compara EXACTO desde `f187270`).
 * Traducirlo la dejaría reservando una cosa y pidiendo otra en el mostrador — y a la dueña
 * buscando en su agenda un servicio que no se llama así en ningún sitio del sistema.
 *
 * Así que se traduce lo de DEBAJO. Esta línea añade, no sustituye: dice qué es sin tocar
 * cómo se llama, y es la única forma de que una clienta rusa entienda «Mechas Balayage» sin
 * que deje de poder pedirlo por su nombre al llegar.
 *
 * Lo escribe la dueña, y sin texto no hay línea — no se compone una descripción a partir
 * del nombre ni de la categoría (regla 3). Desde el 21/08/2026 sale en 21 de las 82
 * entradas: las variantes de las seis categorías que van por largo y las tres coberturas de
 * mechas clásicas, todas de una sola línea. El resto del catálogo sigue sin ella.
 */
function Explicacion({ texto }: { texto: string | null }) {
  if (!texto) return null;
  return <span className="mt-0.5 block text-sm text-muted-foreground">{texto}</span>;
}

/** Una fila tocable: la unidad de casi toda la pantalla. */
function Fila({
  onClick, children, destacada = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  destacada?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-16 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        destacada
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-card hover:bg-muted/60 active:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

// ─── Paso 1 · el servicio ────────────────────────────────────────────────────────────────

export function ListaServicios({
  t, grupos, elegir,
}: {
  t: Textos;
  grupos: GrupoServicio[];
  elegir: (g: GrupoServicio) => void;
}) {
  return (
    <>
      <Titulo>{t.elegirServicio}</Titulo>
      <ul className="flex flex-col gap-2">
        {grupos.map((g) => {
          const unica = g.entradas.length === 1 ? g.entradas[0] : null;
          return (
            <li key={g.categoria}>
              <Fila onClick={() => elegir(g)}>
                <span className="min-w-0 flex-1">
                  {/* `titulo`, no `categoria`: con una sola entrada esta fila ES el
                      servicio y tiene que llamarse igual aquí que en la confirmación. */}
                  <span className="block font-medium">{g.titulo}</span>
                  {/* La explicación del GRUPO: la que comparten todas sus entradas. Con una
                      sola entrada es la suya, que es lo que se quiere aquí. Cuando difieren
                      —«hasta los hombros» / «hasta la espalda»— no sale nada en este paso:
                      es información de la VARIANTE y su sitio es el paso siguiente. */}
                  <Explicacion texto={g.explicacion} />
                  <span className="mt-0.5 block text-sm text-muted-foreground">
                    {unica
                      ? [formatearPrecio(unica.precio, t), formatearDuracion(unica.duracion, t)]
                          .filter(Boolean)
                          .join(" · ")
                      : `${g.entradas.length} ${t.opciones}${
                          g.desde !== null ? ` · ${t.desde} ${formatearPrecio(g.desde, t)}` : ""
                        }`}
                  </span>
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
              </Fila>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Las dos salidas voluntarias, debajo de la lista y no encima: quien sabe lo que quiere no
 * tiene que leerlas, y quien no lo sabe llega aquí después de mirar y no encontrarse.
 *
 * Ninguna de las dos la sabe hacer el formulario y por eso son enlaces a una persona: la
 * Consulta de valoración está prohibida al bot desde el 02/08 y el motor ni siquiera puede
 * VER si hay dos estilistas libres a la misma hora. Sin ellas, esos dos casos terminan en
 * una reserva mal hecha — la de dos personas, en una cita creyendo que son dos.
 */
export function Puertas({ t, puertas }: { t: Textos; puertas: Salon["puertas"] }) {
  const abiertas = [
    { url: puertas.asesoramiento, etiqueta: t.puertaAsesoramiento },
    { url: puertas.variasPersonas, etiqueta: t.puertaVariasPersonas },
  ].filter((p): p is { url: string; etiqueta: string } => !!p.url);
  if (!abiertas.length) return null;   // sin teléfono no se pinta un botón que no lleva a nada

  return (
    <div className="mt-8 border-t border-border/60 pt-5">
      <p className="mb-3 text-sm text-muted-foreground">{t.otrasOpciones}</p>
      <ul className="flex flex-col gap-2">
        {abiertas.map((p) => (
          <li key={p.etiqueta}>
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 text-left text-sm font-medium hover:bg-muted/60 active:bg-muted"
            >
              <MessageCircle className="size-5 shrink-0 text-muted-foreground" />
              {p.etiqueta}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Paso 2 · la variante ────────────────────────────────────────────────────────────────
//
// El encabezado es SIEMPRE el mismo y neutro. La tentación era preguntar «¿qué largo
// tienes?», y sería mentira en «Mechas clásicas», cuyas variantes son cantidad de cobertura
// y no largo (está avisado en el brief). Un texto por categoría es de la dueña, no nuestro.
export function ListaVariantes({
  t, grupo, elegir,
}: {
  t: Textos;
  grupo: GrupoServicio;
  elegir: (e: EntradaCatalogo) => void;
}) {
  return (
    <>
      <p className="mb-1 text-sm font-medium text-primary">{grupo.categoria}</p>
      <Titulo>{t.elegirVariante}</Titulo>
      {/* Lo que es COMÚN a todas las variantes se dice UNA vez, aquí arriba, y no repetido
          cuatro veces en las cuatro filas. */}
      {grupo.explicacion && (
        <p className="-mt-2 mb-4 text-sm text-muted-foreground">{grupo.explicacion}</p>
      )}
      <ul className="flex flex-col gap-2">
        {grupo.entradas.map((e) => {
          const dur = formatearDuracion(e.duracion, t);
          // Solo si dice algo DISTINTO de lo de arriba. Es lo que hace que el mismo campo
          // sirva para las dos cosas: escrito igual en todas, es del servicio y sale una
          // vez; escrito distinto, es de la variante y sale en su fila. Y ahí es donde va
          // «hasta los hombros» el día que la dueña lo escriba — que es el hueco que pedía
          // este encargo, y que vale igual para «media cabeza» de las mechas clásicas,
          // porque el campo no se llama «largo» ni pregunta por el largo.
          const propia = e.explicacion && e.explicacion !== grupo.explicacion ? e.explicacion : null;
          return (
            <li key={e.key}>
              <Fila onClick={() => elegir(e)}>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{e.nombre}</span>
                  <Explicacion texto={propia} />
                  {dur && <span className="mt-0.5 block text-sm text-muted-foreground">{dur}</span>}
                </span>
                <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
                  {formatearPrecio(e.precio, t)}
                </span>
              </Fila>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ─── Paso 3 · el día ─────────────────────────────────────────────────────────────────────

export function Rejilla({
  t, lang, meses, indice, mover, fecha, elegir,
}: {
  t: Textos;
  lang: string;
  meses: Mes[];
  indice: number;
  mover: (delta: number) => void;
  fecha: string | null;
  elegir: (f: string) => void;
}) {
  const mes = meses[indice];
  if (!mes) return null;
  const puedeAtras = meses.slice(0, indice).some((m) => m.casillas.some((c) => c.elegible));
  const puedeAdelante = meses.slice(indice + 1).some((m) => m.casillas.some((c) => c.elegible));

  return (
    <>
      <Titulo>{t.elegirDia}</Titulo>
      <div className="rounded-2xl border border-border bg-card p-3">
        <div className="mb-2 flex items-center justify-between">
          <BotonMes onClick={() => mover(-1)} activo={puedeAtras} etiqueta={t.mesAnterior}>
            <ChevronLeft className="size-5" />
          </BotonMes>
          <span className="font-heading text-base font-semibold first-letter:uppercase">
            {etiquetaMes(mes.anio, mes.mes, lang)}
          </span>
          <BotonMes onClick={() => mover(1)} activo={puedeAdelante} etiqueta={t.mesSiguiente}>
            <ChevronRight className="size-5" />
          </BotonMes>
        </div>

        <div className="grid grid-cols-7 gap-1 pb-1 text-center text-xs text-muted-foreground">
          {t.inicialesDias.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {mes.casillas.map((c, i) => (
            <CasillaDia key={c.fecha ?? `hueco-${i}`} c={c} elegida={!!c.fecha && c.fecha === fecha} elegir={elegir} />
          ))}
        </div>
      </div>
    </>
  );
}

function BotonMes({
  onClick, activo, etiqueta, children,
}: {
  onClick: () => void;
  activo: boolean;
  etiqueta: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!activo}
      aria-label={etiqueta}
      className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function CasillaDia({
  c, elegida, elegir,
}: {
  c: Casilla;
  elegida: boolean;
  elegir: (f: string) => void;
}) {
  if (!c.fecha) return <span aria-hidden />;
  return (
    <button
      type="button"
      disabled={!c.elegible}
      onClick={() => elegir(c.fecha as string)}
      aria-current={elegida ? "date" : undefined}
      className={cn(
        "flex aspect-square min-h-11 items-center justify-center rounded-xl text-sm tabular-nums transition-colors",
        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        elegida && "bg-primary font-semibold text-primary-foreground",
        !elegida && c.elegible && "bg-accent/25 font-medium text-foreground hover:bg-accent/45",
        !c.elegible && "text-muted-foreground/35",
      )}
    >
      {c.dia}
    </button>
  );
}

// ─── Paso 4 · la hora ────────────────────────────────────────────────────────────────────

export function ListaHoras({
  t, cuando, horas, hora, elegir, otroDia,
}: {
  t: Textos;
  cuando: string;
  horas: string[];
  hora: string | null;
  elegir: (h: string) => void;
  otroDia: () => void;
}) {
  return (
    <>
      <p className="mb-1 text-sm font-medium text-primary first-letter:uppercase">{cuando}</p>
      <Titulo>{t.elegirHora}</Titulo>
      {horas.length === 0 ? (
        <Nota texto={t.sinHoras} accion={{ etiqueta: t.otroDia, onClick: otroDia }} />
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {horas.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => elegir(h)}
              className={cn(
                "min-h-14 rounded-2xl border text-base font-medium tabular-nums transition-colors",
                "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                h === hora
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card hover:bg-muted/60 active:bg-muted",
              )}
            >
              {h}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Paso 5 · sus datos ──────────────────────────────────────────────────────────────────

export function Datos({
  t, lang, resumen, nombre, telefono, paises, pais, setNombre, setTelefono, setPais, errores, tocado,
}: {
  t: Textos;
  lang: Idioma;
  resumen: { servicio: string; cuando: string; precio: string };
  nombre: string;
  telefono: string;
  paises: Pais[];
  pais: Pais;
  setNombre: (v: string) => void;
  setTelefono: (v: string) => void;
  setPais: (codigo: string) => void;
  // El teléfono no trae un booleano sino el PROBLEMA (o null): «parece que falta algún
  // dígito» sobre un número con letras describe otro caso, y quien lo lee repasa las cifras
  // una por una sin ver lo que sobra.
  errores: { nombre: boolean; telefono: ProblemaTelefono | null };
  tocado: boolean;
}) {
  return (
    <>
      <Titulo>{t.pasoDatos}</Titulo>

      <div className="mb-5 rounded-2xl border border-border bg-secondary/40 p-4">
        <p className="text-xs tracking-wide text-muted-foreground uppercase">{t.resumen}</p>
        <p className="mt-1 font-medium">{resumen.servicio}</p>
        <p className="text-sm text-muted-foreground first-letter:uppercase">{resumen.cuando}</p>
        <p className="mt-1 text-sm font-semibold">{resumen.precio}</p>
      </div>

      <div className="flex flex-col gap-4">
        <Campo
          id="nombre"
          etiqueta={t.tuNombre}
          ayuda={t.tuNombreAyuda}
          error={tocado && errores.nombre ? t.nombreCorto : null}
          valor={nombre}
          onChange={setNombre}
          autoComplete="name"
          inputMode="text"
        />
        <CampoTelefono
          t={t}
          lang={lang}
          paises={paises}
          pais={pais}
          setPais={setPais}
          valor={telefono}
          onChange={setTelefono}
          error={tocado && errores.telefono ? t.telefonoProblema[errores.telefono] : null}
        />
      </div>
    </>
  );
}

function Campo({
  id, etiqueta, ayuda, error, valor, onChange, autoComplete, inputMode, type = "text",
}: {
  id: string;
  etiqueta: string;
  ayuda: string;
  error: string | null;
  valor: string;
  onChange: (v: string) => void;
  autoComplete: string;
  inputMode: "text" | "tel";
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {etiqueta}
      </label>
      <input
        id={id}
        type={type}
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-ayuda`}
        className={cn(
          "h-14 w-full rounded-2xl border bg-card px-4 text-base transition-colors",
          "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          error ? "border-destructive" : "border-border",
        )}
      />
      <p id={`${id}-ayuda`} className={cn("mt-1.5 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? ayuda}
      </p>
    </div>
  );
}

/**
 * El teléfono, con el país aparte.
 *
 * ── POR QUÉ SON DOS CONTROLES Y NO UNO ───────────────────────────────────────────────────
 *
 * Era un campo suelto y el servidor le pegaba el `34` a todo lo que fueran nueve dígitos
 * empezados por 6 o 7 — o sea a un móvil ucraniano escrito sin el 0 del tronco, que salía
 * convertido en un móvil ESPAÑOL de otra persona. El porqué entero, con los números medidos
 * contra la tabla de contactos, está en `services/reserva-web.js`.
 *
 * ── UN `<select>` NATIVO, Y ES LA DECISIÓN ───────────────────────────────────────────────
 *
 * En un móvil el desplegable del sistema es una rueda a pantalla completa, con búsqueda por
 * teclado y accesible sin que escribamos una línea. Cualquier lista propia sería peor y más
 * grande, y esta pantalla se ve con una mano.
 *
 * El truco de encima: el `<select>` va TRANSPARENTE y a tamaño completo sobre una cajita que
 * enseña «+34». Cerrado ocupa cuatro caracteres —que es todo lo que cabe al lado del número
 * en una pantalla de 375 px— y abierto el sistema enseña los nombres largos de país. Un
 * `<select>` normal tendría que enseñar «+34 · España» también cerrado, y no cabe.
 *
 * Y el nombre de cada país lo pone el NAVEGADOR (`nombrePais` → `Intl.DisplayNames`), no
 * nuestra tabla de textos: son 17 países × 4 idiomas, y traducirlos a mano es escribir 68
 * cadenas que nadie revisa para decir «Ucrania».
 */
function CampoTelefono({
  t, lang, paises, pais, setPais, valor, onChange, error,
}: {
  t: Textos;
  lang: Idioma;
  paises: Pais[];
  pais: Pais;
  setPais: (codigo: string) => void;
  valor: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  return (
    <div>
      {/* UNA etiqueta para los dos controles: lo que se pide es un teléfono, y el país es
          parte de él. El desplegable se anuncia aparte con su `aria-label`. */}
      <label htmlFor="telefono" className="mb-1.5 block text-sm font-medium">
        {t.tuTelefono}
      </label>
      <div className="flex gap-2">
        <div className="relative shrink-0">
          <div
            aria-hidden
            className={cn(
              "pointer-events-none flex h-14 items-center gap-1 rounded-2xl border bg-card px-3 text-base tabular-nums",
              error ? "border-destructive" : "border-border",
            )}
          >
            {prefijoVisible(pais)}
            <ChevronDown className="size-4 text-muted-foreground" />
          </div>
          <select
            aria-label={t.tuPais}
            value={pais.codigo}
            onChange={(e) => setPais(e.target.value)}
            className="absolute inset-0 size-full cursor-pointer rounded-2xl opacity-0 focus-visible:opacity-100"
          >
            {paises.map((p) => (
              <option key={p.codigo} value={p.codigo}>
                {prefijoVisible(p)} · {nombrePais(p.iso, lang)}
              </option>
            ))}
          </select>
        </div>
        <input
          id="telefono"
          type="tel"
          value={valor}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="tel-national"
          inputMode="tel"
          aria-invalid={error ? true : undefined}
          aria-describedby="telefono-ayuda"
          className={cn(
            "h-14 min-w-0 flex-1 rounded-2xl border bg-card px-4 text-base transition-colors",
            "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            error ? "border-destructive" : "border-border",
          )}
        />
      </div>
      <p
        id="telefono-ayuda"
        className={cn("mt-1.5 text-xs", error ? "text-destructive" : "text-muted-foreground")}
      >
        {error ?? t.tuTelefonoAyuda}
      </p>
    </div>
  );
}

// ─── El botón de confirmar, abajo y fijo ─────────────────────────────────────────────────
//
// `disabled` mientras se envía es la mitad visible del candado del doble toque; la otra
// mitad —la que de verdad protege— es el cerrojo síncrono de la máquina, porque el estado de
// React se actualiza DESPUÉS y entre dos toques rápidos no ha llegado a cambiar.
export function BarraConfirmar({
  t, enviando, onClick,
}: {
  t: Textos;
  enviando: boolean;
  onClick: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-border/60 bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
      <div className="mx-auto max-w-md">
        <button
          type="button"
          onClick={onClick}
          disabled={enviando}
          className={cn(
            "flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-semibold text-primary-foreground",
            "transition-opacity focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-60",
          )}
        >
          {enviando && <LoaderCircle className="size-5 animate-spin" />}
          {enviando ? t.confirmando : t.confirmar}
        </button>
      </div>
    </div>
  );
}

// ─── Avisos ──────────────────────────────────────────────────────────────────────────────

export function Nota({
  texto, accion,
}: {
  texto: string;
  accion?: { etiqueta: string; onClick: () => void };
}) {
  return (
    <div className="rounded-2xl border border-border bg-muted/50 p-4 text-sm">
      <p className="text-muted-foreground">{texto}</p>
      {accion && (
        <button
          type="button"
          onClick={accion.onClick}
          className="mt-3 min-h-11 font-medium text-primary underline underline-offset-4"
        >
          {accion.etiqueta}
        </button>
      )}
    </div>
  );
}

/**
 * El aviso de que algo no ha podido ser. Sale con el texto de su motivo, y con las salidas
 * que ese motivo permite: WhatsApp cuando la respuesta lo trae, y reintentar cuando tiene
 * sentido volver a darle. Nunca se queda sin ninguna de las dos.
 */
export function Aviso({
  t, fallo, whatsappDeRespaldo, reintentar, enCarga = false,
}: {
  t: Textos;
  fallo: Fallo;
  whatsappDeRespaldo: string | null;
  reintentar: (() => void) | null;
  enCarga?: boolean;
}) {
  const texto = textoDelAviso(t, fallo, { enCarga });
  const espera = textoEspera(t, fallo.esperaSegundos);
  // El respaldo SOLO entra cuando no hubo respuesta que obedecer. Ver `enlaceDelAviso`.
  const wa = enlaceDelAviso(fallo, whatsappDeRespaldo);

  return (
    <div
      role="status"
      className="mb-5 rounded-2xl border border-primary/25 bg-primary/5 p-4"
    >
      <p className="font-medium">{texto.titulo}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {texto.cuerpo}
        {espera ? ` ${espera}` : ""}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {reintentar && (
          <button
            type="button"
            onClick={reintentar}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="size-4" />
            {t.reintentar}
          </button>
        )}
        {wa && (
          <a
            href={wa}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"
          >
            <MessageCircle className="size-4" />
            {t.escribirWhatsApp}
          </a>
        )}
      </div>
    </div>
  );
}

/** El aviso que ocupa la pantalla entera: no hay formulario detrás que enseñar. */
export function AvisoAPantalla({
  t, fallo, whatsappDeRespaldo, reintentar, enCarga = false,
}: {
  t: Textos;
  fallo: Fallo;
  whatsappDeRespaldo: string | null;
  reintentar: (() => void) | null;
  enCarga?: boolean;
}) {
  return (
    <div className="py-10">
      <Aviso t={t} fallo={fallo} whatsappDeRespaldo={whatsappDeRespaldo} reintentar={reintentar} enCarga={enCarga} />
    </div>
  );
}

// ─── La pantalla final ───────────────────────────────────────────────────────────────────

export function Confirmada({
  t, salon, direccion, cita,
}: {
  t: Textos;
  salon: string | null;
  direccion: string | null;
  cita: { cuando: string | null; fecha: string; hora: string; servicio: string | null; estilista: string | null };
}) {
  // `cuando` viene del servidor, del MISMO formateador que el recordatorio de 24 h. Si no se
  // pudo formatear, se enseñan la hora y la fecha sueltas: una cita escrita no se esconde por
  // un problema de redacción.
  const cuando = cita.cuando ?? `${cita.hora} · ${cita.fecha}`;
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <span className="mb-5 flex size-20 items-center justify-center rounded-full bg-accent">
        <Check className="size-10 text-foreground" strokeWidth={2.5} />
      </span>

      <h1 className="font-heading text-2xl leading-snug font-semibold text-balance">
        {salon ? rellenar(t.confirmadaTitulo, { salon }) : t.confirmadaSinSalon}
      </h1>

      <div className="mt-6 w-full rounded-2xl border border-border bg-card p-5 text-left">
        {cita.servicio && <p className="font-medium">{cita.servicio}</p>}
        <p className="mt-1 text-lg first-letter:uppercase">{cuando}</p>
        {cita.estilista && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t.estilistaEtiqueta}: {cita.estilista}
          </p>
        )}
        {/* Quien acaba de reservar necesita saber dónde va. Si la dueña no la ha escrito no
            se inventa nada: simplemente no sale. */}
        {direccion && (
          <p className="mt-3 border-t border-border/60 pt-3 text-sm text-muted-foreground">
            {direccion}
          </p>
        )}
      </div>

      <p className="mt-6 text-sm text-muted-foreground text-balance">{t.avisoRecordatorio}</p>
    </div>
  );
}
