/**
 * formulario-reserva.tsx — La máquina del enlace público de reserva.
 *
 * Servicio → variante (solo si la categoría tiene varias) → día → hora → nombre y teléfono →
 * confirmación. Un paso por pantalla, en una columna, para un móvil sostenido con una mano.
 *
 * ── EL CANDADO DEL DOBLE TOQUE ───────────────────────────────────────────────────────────
 *
 * Lo primero que hace `confirmar()` es mirar un `useRef`, y eso NO es intercambiable por un
 * `useState`: el estado de React se aplica en el siguiente render, y entre dos toques
 * separados por 150 ms no ha llegado a cambiar — los dos manejadores leerían `false` y
 * saldrían dos peticiones. El `disabled` del botón es la mitad VISIBLE del candado; la que
 * de verdad protege es el cerrojo síncrono. Es la lección del doble cobro de la caja.
 *
 * Y el cerrojo NO se suelta cuando la reserva sale bien: se queda echado y la pantalla pasa
 * a un paso que ni siquiera tiene botón. Solo se libera cuando ha fallado, que es cuando
 * ella tiene que poder volver a intentarlo.
 *
 * Esto tapa el doble toque de ESTA pantalla. Lo que no puede tapar desde aquí son dos
 * pestañas o un reenvío desde otro sitio: eso se para en Express (ver el dedupe de
 * `webhook.js`) y en el claim atómico de `reservar_hueco()`.
 *
 * ── CUANDO EL HUECO SE LO LLEVA OTRA ─────────────────────────────────────────────────────
 *
 * La respuesta trae `recargarHuecos`, y cuando viene la página recarga SOLA —los huecos del
 * día y la rejilla del mes— y vuelve al paso de la hora con el aviso arriba. La clienta no
 * tiene que entender qué ha pasado ni pulsar nada para volver a ver la agenda buena. Si el
 * día se ha quedado sin nada, se la lleva al calendario en vez de dejarla mirando un hueco.
 *
 * ── SI SE CAE ALGO POR DETRÁS ────────────────────────────────────────────────────────────
 *
 * Ninguna respuesta se pinta en crudo. Todo pasa por `interpretarFallo`, que solo conoce un
 * conjunto cerrado de motivos y manda cualquier otra cosa a 'error_interno' —que tiene texto
 * en castellano y una salida—. Un `fetch` que ni siquiera contesta es 'sin_conexion'. Y si
 * algo revienta al pintar, el que responde es `error.tsx`.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DiaConHueco,
  type EntradaCatalogo,
  type Fallo,
  type GrupoServicio,
  agruparCatalogo,
  etiquetaDia,
  falloSinConexion,
  hoyEnElSalon,
  idiomaValido,
  interpretarFallo,
  mesesConDisponibilidad,
  nombreUsable,
  primerMesConHueco,
  telefonoUsable,
  textos,
  formatearPrecio,
} from "@/lib/reservar/nucleo";
import {
  Aviso,
  AvisoAPantalla,
  BarraConfirmar,
  Cabecera,
  Cargando,
  Confirmada,
  Datos,
  ListaHoras,
  ListaServicios,
  ListaVariantes,
  Rejilla,
} from "@/components/reservar/piezas";

type Paso = "servicio" | "variante" | "dia" | "hora" | "datos" | "hecha";

type Salon = { nombre: string | null; whatsapp: string | null };

type CitaHecha = {
  fecha: string;
  hora: string;
  cuando: string | null;
  servicio: string | null;
  estilista: string | null;
};

type Resultado<T> = { ok: true; datos: T } | { ok: false; fallo: Fallo };

/**
 * Una llamada a NUESTRO Next (nunca a Express: el navegador no conoce esa URL ni el secreto).
 * No lanza nunca — devuelve un `Fallo` del conjunto cerrado, que es lo que permite que la
 * pantalla no tenga ni un `catch` suelto donde inventarse un mensaje.
 */
async function pedir<T>(url: string, init?: RequestInit): Promise<Resultado<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, fallo: falloSinConexion() };
  }
  let cuerpo: unknown = null;
  try {
    cuerpo = await res.json();
  } catch {
    cuerpo = null; // Express caído devolviendo HTML: no se enseña, se traduce.
  }
  const dice = cuerpo && typeof cuerpo === "object" ? (cuerpo as { ok?: unknown }).ok : undefined;
  if (!res.ok || dice !== true) return { ok: false, fallo: interpretarFallo(res.status, cuerpo) };
  return { ok: true, datos: cuerpo as T };
}

export function FormularioReserva({ slug, lang }: { slug: string; lang: string }) {
  const idioma = idiomaValido(lang);
  const t = textos(idioma);
  const base = `/api/reservar/${encodeURIComponent(slug)}`;

  // ── Carga inicial ──
  const [cargando, setCargando] = useState(true);
  const [falloInicial, setFalloInicial] = useState<Fallo | null>(null);
  const [salon, setSalon] = useState<Salon>({ nombre: null, whatsapp: null });
  const [grupos, setGrupos] = useState<GrupoServicio[]>([]);
  // El HOY del salón se calcula ya en el navegador (nunca durante el render del servidor,
  // que daría dos valores distintos y un aviso de hidratación).
  const [hoy, setHoy] = useState<string | null>(null);

  // ── Lo que va eligiendo ──
  const [paso, setPaso] = useState<Paso>("servicio");
  const [grupo, setGrupo] = useState<GrupoServicio | null>(null);
  const [entrada, setEntrada] = useState<EntradaCatalogo | null>(null);
  const [dias, setDias] = useState<DiaConHueco[]>([]);
  const [cargandoDias, setCargandoDias] = useState(false);
  // El mes que se está mirando. `null` = «el que decida la disponibilidad»: así el
  // calendario abre por el primer mes con algo sin necesidad de un efecto que corrija el
  // índice después de pintar.
  const [mesTocado, setMesTocado] = useState<number | null>(null);
  const [fecha, setFecha] = useState<string | null>(null);
  const [horas, setHoras] = useState<string[]>([]);
  const [cargandoHoras, setCargandoHoras] = useState(false);
  const [hora, setHora] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [tocado, setTocado] = useState(false);

  // ── El envío ──
  const [enviando, setEnviando] = useState(false);
  // El aviso viaja con SU propio reintento. Sin esto, el botón «volver a intentarlo» de un
  // fallo al cargar los días acabaría llamando a confirmar la reserva.
  const [aviso, setAviso] = useState<{ fallo: Fallo; reintentar: (() => void) | null } | null>(null);
  const [sinSalida, setSinSalida] = useState(false);
  const [cita, setCita] = useState<CitaHecha | null>(null);

  // El cerrojo del doble toque. Un ref y no un estado: ver la cabecera.
  const cerrojo = useRef(false);
  // Cada carga lleva número: si la clienta toca dos días seguidos, la respuesta lenta del
  // primero no puede pintarse encima de la del segundo.
  const nDias = useRef(0);
  const nHoras = useRef(0);

  // ── Cargas ────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    let vivo = true;
    (async () => {
      setHoy(hoyEnElSalon());
      const r = await pedir<{ salon?: Salon; servicios?: unknown }>(`${base}/catalogo?lang=${idioma}`);
      if (!vivo) return;
      if (!r.ok) {
        setFalloInicial(r.fallo);
        setCargando(false);
        return;
      }
      setSalon({
        nombre: r.datos.salon?.nombre ?? null,
        whatsapp: r.datos.salon?.whatsapp ?? null,
      });
      setGrupos(agruparCatalogo(r.datos.servicios).grupos);
      setCargando(false);
    })();
    return () => { vivo = false; };
  }, [base, idioma]);

  const cargarDias = useCallback(async (clave: string) => {
    const mio = ++nDias.current;
    setCargandoDias(true);
    const r = await pedir<{ dias?: DiaConHueco[] }>(
      `${base}/dias?servicio=${encodeURIComponent(clave)}&lang=${idioma}`,
    );
    if (mio !== nDias.current) return;   // llegó tarde: manda la petición nueva
    setCargandoDias(false);
    if (!r.ok) {
      setAviso({ fallo: r.fallo, reintentar: () => void cargarDias(clave) });
      setDias([]);
      return;
    }
    setDias(Array.isArray(r.datos.dias) ? r.datos.dias : []);
  }, [base, idioma]);

  const cargarHoras = useCallback(async (clave: string, dia: string) => {
    const mio = ++nHoras.current;
    setCargandoHoras(true);
    const r = await pedir<{ huecos?: { hora?: unknown }[] }>(
      `${base}/huecos?servicio=${encodeURIComponent(clave)}&fecha=${dia}&lang=${idioma}`,
    );
    if (mio !== nHoras.current) return;
    setCargandoHoras(false);
    if (!r.ok) {
      setAviso({ fallo: r.fallo, reintentar: () => void cargarHoras(clave, dia) });
      setHoras([]);
      return { vacio: true };
    }
    const lista = (Array.isArray(r.datos.huecos) ? r.datos.huecos : [])
      .map((h) => (typeof h?.hora === "string" ? h.hora : null))
      .filter((h): h is string => !!h);
    setHoras(lista);
    return { vacio: lista.length === 0 };
  }, [base, idioma]);

  // Las cargas se disparan desde el MANEJADOR, no desde un efecto sobre la selección. Los
  // dos caminos que las necesitan —el normal y la recarga automática de `aplicarFallo`— las
  // llaman igual, así que un efecto solo añadiría un render de por medio.
  const meses = hoy ? mesesConDisponibilidad(hoy, dias) : [];
  // El calendario abre por el primer mes que tenga algo, no por el actual: con la agenda
  // llena hasta octubre, abrir en agosto es enseñar una pantalla gris. Se DERIVA al pintar;
  // corregirlo con un efecto movería el mes debajo de los dedos de la clienta.
  const mesIndice = mesTocado ?? Math.max(0, primerMesConHueco(meses));

  // ── Navegación ────────────────────────────────────────────────────────────────────────

  const secuencia: Paso[] = grupo && grupo.entradas.length > 1
    ? ["servicio", "variante", "dia", "hora", "datos"]
    : ["servicio", "dia", "hora", "datos"];
  const numeroPaso = secuencia.indexOf(paso) + 1;

  function irA(destino: Paso) {
    setAviso(null);
    setSinSalida(false);
    setPaso(destino);
  }

  function elegirGrupo(g: GrupoServicio) {
    setGrupo(g);
    setFecha(null); setHora(null); setHoras([]); setDias([]); setMesTocado(null);
    if (g.entradas.length === 1) {
      setEntrada(g.entradas[0]);
      void cargarDias(g.entradas[0].key);
      irA("dia");
    } else {
      setEntrada(null);
      irA("variante");
    }
  }

  function elegirEntrada(e: EntradaCatalogo) {
    setEntrada(e);
    setFecha(null); setHora(null); setHoras([]); setDias([]); setMesTocado(null);
    void cargarDias(e.key);
    irA("dia");
  }

  function elegirDia(f: string) {
    if (!entrada) return;
    setFecha(f);
    setHora(null);
    void cargarHoras(entrada.key, f);
    irA("hora");
  }

  function elegirHora(h: string) {
    setHora(h);
    irA("datos");
  }

  function atras() {
    if (paso === "variante") { setGrupo(null); setEntrada(null); irA("servicio"); return; }
    if (paso === "dia") {
      if (grupo && grupo.entradas.length > 1) { setEntrada(null); irA("variante"); }
      else { setGrupo(null); setEntrada(null); irA("servicio"); }
      return;
    }
    if (paso === "hora") { setHora(null); irA("dia"); return; }
    if (paso === "datos") { irA("hora"); return; }
  }

  // ── El «no» del servidor ──────────────────────────────────────────────────────────────

  const aplicarFallo = useCallback((f: Fallo, reintentar: (() => void) | null) => {
    setAviso({ fallo: f, reintentar });
    const vuelta = (t.motivos[f.motivo] ?? t.motivos.error_interno).vuelta;
    setSinSalida(vuelta === "ninguna");

    // La agenda ha cambiado bajo sus pies: se recarga SOLA. Se piden las dos cosas —el día y
    // la rejilla— porque si ese hueco ya no está, el día entero puede haberse quedado sin
    // nada y el calendario tiene que reflejarlo.
    if (f.recargarHuecos && entrada) {
      setHora(null);
      void cargarDias(entrada.key);
      if (fecha && vuelta !== "dias") {
        setPaso("hora");
        void cargarHoras(entrada.key, fecha).then((r) => {
          // Día sin nada: en vez de dejarla mirando una lista vacía, al calendario.
          if (r?.vacio) setPaso("dia");
        });
      } else {
        setFecha(null);
        setPaso("dia");
      }
      return;
    }

    if (vuelta === "servicio") {
      setGrupo(null); setEntrada(null); setFecha(null); setHora(null); setDias([]); setHoras([]);
      setPaso("servicio");
    } else if (vuelta === "dias") {
      setHora(null);
      setPaso("dia");
    } else if (vuelta === "huecos") {
      setHora(null);
      setPaso("hora");
    }
    // 'datos', 'reintentar' y 'ninguna' se quedan donde están: el aviso sale encima del
    // formulario, con sus datos escritos intactos.
  }, [t, entrada, fecha, cargarDias, cargarHoras]);

  const erroresDatos = { nombre: !nombreUsable(nombre), telefono: !telefonoUsable(telefono) };

  async function confirmar() {
    // ── EL CERROJO. Síncrono y lo primero de todo. ──
    if (cerrojo.current) return;
    if (!entrada || !fecha || !hora) return;

    setTocado(true);
    if (erroresDatos.nombre || erroresDatos.telefono) return;

    cerrojo.current = true;
    setEnviando(true);
    setAviso(null);
    setSinSalida(false);

    const r = await pedir<{ cita?: CitaHecha }>(`${base}/reserva`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        servicio: entrada.key,
        fecha,
        hora,
        nombre: nombre.trim(),
        telefono: telefono.trim(),
        lang: idioma,
      }),
    });

    if (r.ok && r.datos.cita) {
      // El cerrojo se queda ECHADO: hay una cita escrita y no hay nada que reintentar.
      setCita(r.datos.cita);
      setEnviando(false);
      setPaso("hecha");
      return;
    }

    setEnviando(false);
    cerrojo.current = false;
    // Un 200 sin cita no debería existir; si pasa, se trata como avería y no como éxito.
    const fallo = r.ok ? interpretarFallo(200, null) : r.fallo;
    const puedeReintentar = (t.motivos[fallo.motivo] ?? t.motivos.error_interno).vuelta === "reintentar";
    aplicarFallo(fallo, puedeReintentar ? () => void confirmar() : null);
  }

  // ── Pintar ────────────────────────────────────────────────────────────────────────────

  if (cargando) {
    return (
      <Marco>
        <Cabecera t={t} salon={null} atras={null} paso={null} total={0} />
        <Cargando t={t} />
      </Marco>
    );
  }

  if (falloInicial) {
    // Ni catálogo ni salón: no hay formulario detrás que enseñar. El enlace de WhatsApp, si
    // lo trae la respuesta, es lo único que le queda.
    return (
      <Marco>
        <Cabecera t={t} salon={null} atras={null} paso={null} total={0} />
        <AvisoAPantalla
          t={t}
          fallo={falloInicial}
          enCarga
          whatsappDeRespaldo={null}
          // Solo se ofrece recargar donde recargar puede cambiar algo. Con el enlace
          // apagado o con un slug que no existe, el botón devolvería la misma pantalla y
          // parecería que no funciona: la salida buena es el WhatsApp de al lado.
          reintentar={
            (t.motivos[falloInicial.motivo] ?? t.motivos.error_interno).vuelta === "reintentar"
              ? () => window.location.reload()
              : null
          }
        />
      </Marco>
    );
  }

  if (paso === "hecha" && cita) {
    return (
      <Marco>
        <Cabecera t={t} salon={salon.nombre} atras={null} paso={null} total={0} />
        <Confirmada t={t} salon={salon.nombre} cita={cita} />
      </Marco>
    );
  }

  const enDatos = paso === "datos" && !!entrada && !!fecha && !!hora;

  return (
    <Marco conBarra={enDatos && !sinSalida}>
      <Cabecera
        t={t}
        salon={salon.nombre}
        atras={paso === "servicio" ? null : atras}
        paso={numeroPaso > 0 ? numeroPaso : null}
        total={secuencia.length}
      />

      {aviso && (
        <Aviso
          t={t}
          fallo={aviso.fallo}
          whatsappDeRespaldo={salon.whatsapp}
          reintentar={aviso.reintentar ? () => { const f = aviso.reintentar; setAviso(null); f?.(); } : null}
        />
      )}

      {paso === "servicio" && <ListaServicios t={t} grupos={grupos} elegir={elegirGrupo} />}

      {paso === "variante" && grupo && (
        <ListaVariantes t={t} grupo={grupo} elegir={elegirEntrada} />
      )}

      {paso === "dia" && (
        cargandoDias && !dias.length
          ? <Cargando t={t} />
          : meses.length && primerMesConHueco(meses) >= 0
            ? <Rejilla t={t} lang={idioma} meses={meses} indice={mesIndice} mover={(d) => setMesTocado(Math.min(Math.max(mesIndice + d, 0), meses.length - 1))} fecha={fecha} elegir={elegirDia} />
            : <SinDias t={t} whatsapp={salon.whatsapp} />
      )}

      {paso === "hora" && fecha && (
        cargandoHoras
          ? <Cargando t={t} />
          : <ListaHoras t={t} cuando={etiquetaDia(fecha, idioma) ?? fecha} horas={horas} hora={hora} elegir={elegirHora} otroDia={() => irA("dia")} />
      )}

      {enDatos && entrada && (
        <Datos
          t={t}
          resumen={{
            servicio: `${entrada.categoria} · ${entrada.nombre}`,
            // Rótulo suelto, en nominativo: la frase con preposición llega hecha del
            // servidor y solo existe cuando la cita ya está escrita.
            cuando: `${etiquetaDia(fecha, idioma) ?? fecha} · ${hora}`,
            precio: formatearPrecio(entrada.precio, t),
          }}
          nombre={nombre}
          telefono={telefono}
          setNombre={setNombre}
          setTelefono={setTelefono}
          errores={erroresDatos}
          tocado={tocado}
        />
      )}

      {enDatos && !sinSalida && (
        <BarraConfirmar t={t} enviando={enviando} onClick={() => void confirmar()} />
      )}
    </Marco>
  );
}

function SinDias({ t, whatsapp }: { t: ReturnType<typeof textos>; whatsapp: string | null }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/50 p-4 text-sm">
      <p className="text-muted-foreground">{t.sinDias}</p>
      {whatsapp && (
        <a
          href={whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4"
        >
          {t.escribirWhatsApp}
        </a>
      )}
    </div>
  );
}

function Marco({ children, conBarra = false }: { children: React.ReactNode; conBarra?: boolean }) {
  return (
    <div className={`mx-auto min-h-svh w-full max-w-md px-4 ${conBarra ? "pb-32" : "pb-10"} touch-manipulation`}>
      {children}
    </div>
  );
}
