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
  type CitaHecha,
  type DiaConHueco,
  type EntradaCatalogo,
  type Fallo,
  type GrupoServicio,
  type Idioma,
  type Paso,
  type PasoFormulario,
  type Salon,
  SALON_VACIO,
  agruparCatalogo,
  avisoPropio,
  claveProgreso,
  etiquetaDia,
  falloSinConexion,
  hoyEnElSalon,
  idiomaValido,
  interpretarFallo,
  leerProgreso,
  leerSalon,
  limpiarAlVolver,
  pasoAlcanzable,
  pasoDelHistorial,
  restaurar,
  secuenciaDe,
  serializarProgreso,
  trasVerificarHuecos,
  vueltaDe,
  mesesConDisponibilidad,
  nombreUsable,
  problemaTelefono,
  primerMesConHueco,
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
  Puertas,
  Rejilla,
} from "@/components/reservar/piezas";

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
  // El idioma llega RESUELTO del servidor (URL → navegador → castellano) y aquí es estado
  // porque la clienta puede cambiarlo: el navegador se equivoca con una ucraniana que tiene
  // el móvil en ruso, y ése es justo el caso que no se puede dejar sin salida.
  const [idioma, setIdioma] = useState<Idioma>(idiomaValido(lang));
  const t = textos(idioma);
  const base = `/api/reservar/${encodeURIComponent(slug)}`;

  // ── Carga inicial ──
  const [cargando, setCargando] = useState(true);
  const [falloInicial, setFalloInicial] = useState<Fallo | null>(null);
  const [salon, setSalon] = useState<Salon>(SALON_VACIO);
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
  // Restaurar es de UNA vez. El efecto que lo hace vuelve a correr al cambiar de idioma —
  // tiene que volver a pedir el catálogo— y sin esta marca la devolvería al paso guardado
  // justo después de que ella cambiara de idioma, deshaciéndole lo que estuviera haciendo.
  const restaurado = useRef(false);

  // ── La pila del historial ─────────────────────────────────────────────────────────────
  //
  // Va aquí arriba, antes de las cargas, porque la restauración de más abajo necesita apilar
  // entradas y en JavaScript un `useCallback` no existe hasta su línea.

  /**
   * Escribe dónde está en la pila del navegador. La URL NO se toca (pushState sin tercer
   * argumento): el paso no va en la dirección, y por eso un enlace copiado a mitad nunca
   * lleva dentro la reserva de otra persona.
   *
   * Empuja SOLO cuando ella avanza. Retroceder —y los saltos que provoca un «no» del
   * servidor— reemplazan la entrada de arriba: empujar al retroceder dejaría el botón de
   * ADELANTE del navegador llevándola a un paso del que la acabamos de sacar.
   */
  const marcar = useCallback((destino: Paso, empujar: boolean) => {
    if (typeof window === "undefined") return;
    const estado = { reservaPaso: destino };
    if (empujar) window.history.pushState(estado, "");
    else window.history.replaceState(estado, "");
  }, []);

  /** Ella avanza: entrada nueva en la pila, y el atrás la devuelve UN paso. */
  const avanzarA = useCallback((destino: Paso) => {
    setAviso(null);
    setSinSalida(false);
    marcar(destino, true);
    setPaso(destino);
  }, [marcar]);

  /** La movemos nosotros (un «no» del servidor, un día que se quedó vacío). No apila. */
  const saltarA = useCallback((destino: Paso) => {
    marcar(destino, false);
    setPaso(destino);
  }, [marcar]);

  // ── Cargas ────────────────────────────────────────────────────────────────────────────

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
    if (mio !== nHoras.current) return { ok: false, horas: [] };
    setCargandoHoras(false);
    if (!r.ok) {
      setAviso({ fallo: r.fallo, reintentar: () => void cargarHoras(clave, dia) });
      setHoras([]);
      // `ok:false`, no una lista vacía: quien lo lea tiene que poder distinguir «ese día no
      // tiene nada» de «no he podido preguntar». Un cero no es una ausencia (hecho 2), y
      // aquí la diferencia es entre decirle que su hora se ha ocupado o no decirle nada.
      return { ok: false, horas: [] };
    }
    const lista = (Array.isArray(r.datos.huecos) ? r.datos.huecos : [])
      .map((h) => (typeof h?.hora === "string" ? h.hora : null))
      .filter((h): h is string => !!h);
    setHoras(lista);
    return { ok: true, horas: lista };
  }, [base, idioma]);


  useEffect(() => {
    let vivo = true;
    (async () => {
      const hoyLocal = hoyEnElSalon();
      setHoy(hoyLocal);
      const r = await pedir<{ salon?: unknown; servicios?: unknown }>(`${base}/catalogo?lang=${idioma}`);
      if (!vivo) return;
      if (!r.ok) {
        setFalloInicial(r.fallo);
        setCargando(false);
        return;
      }
      setSalon(leerSalon(r.datos.salon));
      const gs = agruparCatalogo(r.datos.servicios).grupos;
      setGrupos(gs);
      setCargando(false);

      // ── VOLVER DONDE ESTABA ──
      //
      // Va DENTRO de esta carga y no en un efecto aparte porque necesita el catálogo recién
      // llegado: el servicio guardado se resuelve contra ÉSE, no contra el de hace un rato.
      // Si la dueña lo dio de baja entremedias, la clave ya no casa y se vuelve al paso 1
      // con el nombre y el teléfono puestos, que ésos no caducan.
      if (restaurado.current) return;
      restaurado.current = true;

      // La entrada de abajo del todo es el paso 1: así el atrás desde el paso 1 sale de la
      // página, que es lo que espera cualquiera.
      marcar("servicio", false);

      let guardado: string | null = null;
      try { guardado = window.sessionStorage.getItem(claveProgreso(slug)); } catch { guardado = null; }
      const plan = restaurar(leerProgreso(guardado, { hoy: hoyLocal, ahora: Date.now() }), { grupos: gs });
      if (!plan) return;

      setNombre(plan.nombre);
      setTelefono(plan.telefono);

      if (plan.paso === "hecha" && plan.cita) {
        cerrojo.current = true;       // no hay nada que reintentar: la cita está escrita
        setCita(plan.cita);
        marcar("hecha", true);
        setPaso("hecha");
        return;
      }

      setGrupo(plan.grupo);
      setEntrada(plan.entrada);
      setFecha(plan.fecha);
      setHora(plan.hora);

      // Se reconstruye la pila hasta donde estaba. Sin esto, el atrás desde el paso 4 la
      // sacaría de la página de un toque, que es la mitad del bug que se está arreglando.
      // El `if` lo pide el StrictMode de desarrollo, que ejecuta los efectos dos veces: sin
      // él la segunda pasada duplicaría las entradas.
      if (pasoDelHistorial(window.history.state) !== plan.paso) {
        const seq = secuenciaDe(plan.grupo);
        for (const q of seq.slice(1, seq.indexOf(plan.paso as PasoFormulario) + 1)) marcar(q, true);
      }
      setPaso(plan.paso);

      // Y lo recuperado NO se cree: lo que estaba libre hace veinte minutos puede ser de
      // otra desde hace diecinueve. Se le vuelve a preguntar al motor y decide
      // `trasVerificarHuecos` — mandarla a confirmar sobre lo guardado sería llevarla a un
      // «no» del servidor que ya sabíamos.
      if (!plan.entrada || !plan.verificar) return;
      const clave = plan.entrada.key;
      void cargarDias(clave);
      if (plan.verificar === "huecos" && plan.fecha) {
        const rh = await cargarHoras(clave, plan.fecha);
        if (!vivo) return;
        const v = trasVerificarHuecos(
          { paso: plan.paso as PasoFormulario, hora: plan.hora },
          { leida: rh.ok, horas: rh.horas },
        );
        if (v.hora !== plan.hora) setHora(v.hora);
        if (v.aviso) setAviso({ fallo: avisoPropio(v.aviso), reintentar: null });
        if (v.paso !== plan.paso) saltarA(v.paso);
      }
    })();
    return () => { vivo = false; };
    // `idioma` está en las dependencias A PROPÓSITO: al cambiarlo hay que volver a pedir el
    // catálogo, porque los enlaces de WhatsApp —las dos puertas y el de respaldo— los redacta
    // el SERVIDOR en el idioma pedido. Los nombres de los servicios no cambian: el catálogo
    // está en castellano y así lo lee la clienta en el salón.
  }, [base, idioma, slug, marcar, saltarA, cargarDias, cargarHoras]);

  /**
   * Cambiar de idioma a mano. Además del estado, se reescribe la URL sin navegar: así
   * recargar o compartir el enlace conserva el idioma que ELLA eligió, no el que dedujimos
   * de su navegador.
   */
  const cambiarIdioma = useCallback((nuevo: Idioma) => {
    setIdioma(nuevo);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("lang", nuevo);
      // `window.history.state` y no `null`: en esa entrada va el paso en el que está, y
      // pasarle null la borraría — el atrás del navegador dejaría de saber dónde volver
      // justo después de cambiar de idioma.
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, []);


  // Las cargas se disparan desde el MANEJADOR, no desde un efecto sobre la selección. Los
  // dos caminos que las necesitan —el normal y la recarga automática de `aplicarFallo`— las
  // llaman igual, así que un efecto solo añadiría un render de por medio.
  const meses = hoy ? mesesConDisponibilidad(hoy, dias) : [];
  // El calendario abre por el primer mes que tenga algo, no por el actual: con la agenda
  // llena hasta octubre, abrir en agosto es enseñar una pantalla gris. Se DERIVA al pintar;
  // corregirlo con un efecto movería el mes debajo de los dedos de la clienta.
  const mesIndice = mesTocado ?? Math.max(0, primerMesConHueco(meses));

  // ── Navegación ────────────────────────────────────────────────────────────────────────

  // La MISMA lista que usa la pila del historial: si el contador de la cabecera y el atrás
  // contaran pasos distintos, «paso 3 de 4» dejaría de significar nada a la segunda vuelta.
  const secuencia: PasoFormulario[] = secuenciaDe(grupo);
  const numeroPaso = secuencia.indexOf(paso as PasoFormulario) + 1;


  function elegirGrupo(g: GrupoServicio) {
    setGrupo(g);
    setFecha(null); setHora(null); setHoras([]); setDias([]); setMesTocado(null);
    if (g.entradas.length === 1) {
      setEntrada(g.entradas[0]);
      void cargarDias(g.entradas[0].key);
      avanzarA("dia");
    } else {
      setEntrada(null);
      avanzarA("variante");
    }
  }

  function elegirEntrada(e: EntradaCatalogo) {
    setEntrada(e);
    setFecha(null); setHora(null); setHoras([]); setDias([]); setMesTocado(null);
    void cargarDias(e.key);
    avanzarA("dia");
  }

  function elegirDia(f: string) {
    if (!entrada) return;
    setFecha(f);
    setHora(null);
    void cargarHoras(entrada.key, f);
    avanzarA("hora");
  }

  function elegirHora(h: string) {
    setHora(h);
    avanzarA("datos");
  }

  /**
   * El «Atrás» de la cabecera NO retrocede él: le pide al navegador que lo haga, y quien
   * mueve la pantalla es el manejador de `popstate`, igual que con el atrás del móvil.
   *
   * Es lo que impide que haya dos formas de retroceder. Con las dos escribiendo estado por su
   * cuenta se separan en el primer retoque —una dejaría la hora puesta y la otra no— y eso no
   * se ve leyendo: hay que retroceder con las dos y comparar.
   */
  function atras() {
    if (typeof window !== "undefined") window.history.back();
  }

  /**
   * Volver a empezar con el formulario limpio. Es lo que hace el atrás DESDE la confirmación:
   * el caso real es reservar también para la hija. El progreso guardado se borra, así que una
   * recarga después de esto no la devuelve al acuse de la cita anterior.
   */
  const empezarDeNuevo = useCallback(() => {
    try { window.sessionStorage.removeItem(claveProgreso(slug)); } catch { /* pestaña privada */ }
    // El cerrojo se soltó al confirmar sólo si hubo fallo; aquí se suelta porque lo que
    // viene es una reserva DISTINTA. Repetir la anterior sin querer no puede: el formulario
    // está vacío, y aun así la pararían el candado de Express y el tope de citas futuras.
    cerrojo.current = false;
    setCita(null);
    setGrupo(null); setEntrada(null); setFecha(null); setHora(null);
    setDias([]); setHoras([]); setMesTocado(null);
    setNombre(""); setTelefono(""); setTocado(false);
    setAviso(null); setSinSalida(false);
    setPaso("servicio");
    marcar("servicio", false);
  }, [slug, marcar]);

  // ── El «no» del servidor ──────────────────────────────────────────────────────────────

  const aplicarFallo = useCallback((f: Fallo, reintentar: (() => void) | null) => {
    setAviso({ fallo: f, reintentar });
    const vuelta = vueltaDe(f.motivo);
    setSinSalida(vuelta === "ninguna");

    // La agenda ha cambiado bajo sus pies: se recarga SOLA. Se piden las dos cosas —el día y
    // la rejilla— porque si ese hueco ya no está, el día entero puede haberse quedado sin
    // nada y el calendario tiene que reflejarlo.
    if (f.recargarHuecos && entrada) {
      setHora(null);
      void cargarDias(entrada.key);
      if (fecha && vuelta !== "dias") {
        saltarA("hora");
        void cargarHoras(entrada.key, fecha).then((r) => {
          // Día sin nada: en vez de dejarla mirando una lista vacía, al calendario. Solo si
          // la lectura SALIÓ: un fallo de red no es un día vacío.
          if (r.ok && !r.horas.length) saltarA("dia");
        });
      } else {
        setFecha(null);
        saltarA("dia");
      }
      return;
    }

    if (vuelta === "servicio") {
      setGrupo(null); setEntrada(null); setFecha(null); setHora(null); setDias([]); setHoras([]);
      saltarA("servicio");
    } else if (vuelta === "dias") {
      setHora(null);
      saltarA("dia");
    } else if (vuelta === "huecos") {
      setHora(null);
      saltarA("hora");
    }
    // 'datos', 'reintentar' y 'ninguna' se quedan donde están: el aviso sale encima del
    // formulario, con sus datos escritos intactos.
  }, [entrada, fecha, cargarDias, cargarHoras, saltarA]);

  // El veredicto del teléfono lo sigue dando `telefonoUsable` (permisivo a propósito);
  // `problemaTelefono` solo elige QUÉ se le dice a quien ya está parado.
  // ── El atrás del navegador, la recarga y lo que se guarda ─────────────────────────────
  //
  // Las tres cosas del mismo arreglo, y en este orden a propósito: el manejador de `popstate`
  // tiene que estar puesto antes de que la restauración empiece a apilar entradas.

  useEffect(() => {
    function alVolver(ev: PopStateEvent) {
      const pedido = pasoDelHistorial(ev.state);
      // Fuera de nuestra pila: la clienta ha llegado a lo que había ANTES de esta página.
      // No se toca nada — que el navegador la saque, que es lo que ella está pidiendo.
      if (!pedido) return;

      if (cita) { empezarDeNuevo(); return; }

      // Recortar al último paso que de verdad tiene datos. Lo pide el botón de ADELANTE,
      // que es el que nadie prueba: volver al día borra la hora, y darle a adelante pedía
      // «tus datos» sin hora — un paso que no se pinta, o sea la pantalla en blanco.
      const destino = pasoAlcanzable(pedido, { grupo, entrada, fecha, hora });
      const olvidar = limpiarAlVolver(destino);
      if (olvidar.grupo) setGrupo(null);
      if (olvidar.entrada) setEntrada(null);
      if (olvidar.fecha) setFecha(null);
      if (olvidar.hora) setHora(null);
      if (olvidar.listas) { setDias([]); setHoras([]); setMesTocado(null); }
      setAviso(null);
      setSinSalida(false);
      setPaso(destino);
      // Si hubo recorte, la entrada de arriba tiene que decir dónde está de verdad, o el
      // siguiente atrás no movería nada y parecería que el botón no funciona.
      if (destino !== pedido) marcar(destino, false);
    }
    window.addEventListener("popstate", alVolver);
    return () => window.removeEventListener("popstate", alVolver);
  }, [cita, grupo, entrada, fecha, hora, marcar, empezarDeNuevo]);


  /**
   * Guardar. `sessionStorage` y no `localStorage`: muere al cerrar la pestaña, y ahí dentro
   * hay un nombre y un teléfono.
   *
   * OJO al tocar las dependencias: este efecto solo puede correr DESPUÉS de que la
   * restauración haya aplicado su estado. Corre por dependencias —no en cada render— y por
   * eso en el commit en que la restauración se dispara no llega a ejecutarse: `paso`,
   * `entrada` y compañía todavía valen lo de antes. Quitarle las dependencias o meterle
   * valores que cambian solos haría que borrara lo guardado justo antes de restaurarlo.
   */
  useEffect(() => {
    if (!restaurado.current) return;
    try {
      const clave = claveProgreso(slug);
      if (cita) {
        window.sessionStorage.setItem(clave, serializarProgreso({ paso: "hecha", cita }, Date.now()));
        return;
      }
      if (!entrada || paso === "hecha") { window.sessionStorage.removeItem(clave); return; }
      window.sessionStorage.setItem(clave, serializarProgreso({
        paso: paso as PasoFormulario,
        servicio: entrada.key,
        fecha, hora, nombre, telefono,
      }, Date.now()));
    } catch { /* pestaña privada o cuota llena: se pierde el progreso, nunca la reserva */ }
  }, [slug, paso, entrada, fecha, hora, nombre, telefono, cita]);

  const erroresDatos = { nombre: !nombreUsable(nombre), telefono: problemaTelefono(telefono) };

  async function confirmar() {
    // ── EL CERROJO. Síncrono y lo primero de todo. ──
    if (cerrojo.current) return;
    if (!entrada || !fecha || !hora) return;

    setTocado(true);
    if (erroresDatos.nombre || erroresDatos.telefono !== null) return;

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
      // REEMPLAZA la entrada de «tus datos» en vez de apilar otra: así el atrás desde el
      // acuse cae en la pila del formulario y no en un paso «hecha» repetido. Lo que hace
      // al llegar ahí lo decide el manejador de `popstate` — empezar de nuevo.
      marcar("hecha", false);
      setPaso("hecha");
      return;
    }

    setEnviando(false);
    cerrojo.current = false;
    // Un 200 sin cita no debería existir; si pasa, se trata como avería y no como éxito.
    const fallo = r.ok ? interpretarFallo(200, null) : r.fallo;
    const puedeReintentar = vueltaDe(fallo.motivo) === "reintentar";
    aplicarFallo(fallo, puedeReintentar ? () => void confirmar() : null);
  }

  // ── Pintar ────────────────────────────────────────────────────────────────────────────

  if (cargando) {
    return (
      <Marco>
        <Cabecera t={t} salon={null} atras={null} paso={null} total={0} idioma={idioma} cambiarIdioma={cambiarIdioma} />
        <Cargando t={t} />
      </Marco>
    );
  }

  if (falloInicial) {
    // Ni catálogo ni salón: no hay formulario detrás que enseñar. El enlace de WhatsApp, si
    // lo trae la respuesta, es lo único que le queda.
    return (
      <Marco>
        <Cabecera t={t} salon={null} atras={null} paso={null} total={0} idioma={idioma} cambiarIdioma={cambiarIdioma} />
        <AvisoAPantalla
          t={t}
          fallo={falloInicial}
          enCarga
          whatsappDeRespaldo={null}
          // Solo se ofrece recargar donde recargar puede cambiar algo. Con el enlace
          // apagado o con un slug que no existe, el botón devolvería la misma pantalla y
          // parecería que no funciona: la salida buena es el WhatsApp de al lado.
          reintentar={vueltaDe(falloInicial.motivo) === "reintentar" ? () => window.location.reload() : null}
        />
      </Marco>
    );
  }

  if (paso === "hecha" && cita) {
    return (
      <Marco>
        <Cabecera t={t} salon={salon.nombre} atras={null} paso={null} total={0} idioma={idioma} cambiarIdioma={cambiarIdioma} />
        <Confirmada t={t} salon={salon.nombre} direccion={salon.direccion} cita={cita} />
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
        idioma={idioma}
        cambiarIdioma={cambiarIdioma}
      />

      {aviso && (
        <Aviso
          t={t}
          fallo={aviso.fallo}
          whatsappDeRespaldo={salon.whatsapp}
          reintentar={aviso.reintentar ? () => { const f = aviso.reintentar; setAviso(null); f?.(); } : null}
        />
      )}

      {paso === "servicio" && (
        <>
          <ListaServicios t={t} grupos={grupos} elegir={elegirGrupo} />
          <Puertas t={t} puertas={salon.puertas} />
        </>
      )}

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
          : <ListaHoras t={t} cuando={etiquetaDia(fecha, idioma) ?? fecha} horas={horas} hora={hora} elegir={elegirHora} otroDia={atras} />
      )}

      {enDatos && entrada && (
        <Datos
          t={t}
          resumen={{
            // `nombreCompleto`, que llega del servidor y es la MISMA cadena que se
            // escribirá en `appointments.service` y que dirá la pantalla final. Componer
            // aquí `categoria · nombre` fabricaba un tercer nombre que no existe en ningún
            // sitio: «Cortes · Mujer y secado» contra «Corte mujer y secado».
            servicio: entrada.nombreCompleto,
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
