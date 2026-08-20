/**
 * nucleo.ts — Todo lo que la pantalla de reserva DECIDE sin React.
 *
 * Es un único fichero a propósito, y sin una sola importación: así se puede `require()`
 * desde un test de Node (`tests/reserva-web-pantalla.test.js`) aprovechando el borrado de
 * tipos que trae Node 25. Un `import` a otro módulo del panel —o un alias `@/`— lo volvería
 * inejecutable fuera de Next, y entonces lo único que se podría probar de la pantalla sería
 * su TEXTO leído con un `grep`, que es medir la redacción y no la conducta.
 *
 * ── QUÉ NO ESTÁ AQUÍ, Y POR QUÉ ──────────────────────────────────────────────────────────
 *
 * **La política de los motivos no se copia.** Qué código HTTP lleva cada motivo, si la
 * página tiene que recargar los huecos y si se abre WhatsApp lo decide `services/reserva-web.js`
 * y VIAJA EN LA RESPUESTA (`recargarHuecos`, `whatsapp`). Aquí solo vive el TEXTO y a qué
 * paso vuelve la clienta. Copiar la política sería tener dos, y la de la pantalla se
 * quedaría vieja el día que alguien tocara la de Express sin abrir este fichero.
 * `tests/reserva-web-pantalla.test.js` cruza las dos: para todo motivo cuya política diga
 * «recarga», el texto de aquí tiene que devolverla a los huecos.
 *
 * **El día de la semana de la confirmación tampoco.** Lo formatea `formatReminderWhen` en el
 * servidor y llega hecho en `cita.cuando`. Es el invariante de CLAUDE.md: el recordatorio de
 * 24 h y esta pantalla le dicen el día a la MISMA clienta, y con dos tablas el mismo jueves
 * saldría de dos formas. Lo que sí vive aquí son las etiquetas SUELTAS de la rejilla (nombre
 * del mes, iniciales de los días), que son otra cosa: rótulos en nominativo, sin preposición
 * delante, que es justo lo que no obliga a declinar en ruso ni en ucraniano.
 *
 * ── IDIOMAS ──────────────────────────────────────────────────────────────────────────────
 *
 * La estructura está montada para los cuatro y **hoy solo hay castellano**. `TEXTOS` es un
 * mapa parcial y `textos()` cae a 'es' con el mismo criterio que el resto del sistema: una
 * clave a medias devuelve la tabla castellana entera, nunca una pantalla con huecos vacíos.
 * Añadir inglés es rellenar una entrada de ese mapa; no se toca ni un componente.
 */

// ─── Idiomas ─────────────────────────────────────────────────────────────────────────────

export type Idioma = 'es' | 'en' | 'ru' | 'uk';

/** Los cuatro del sistema (`IDIOMAS_SOPORTADOS` de helpers.js). Previstos, no traducidos. */
export const IDIOMAS: Idioma[] = ['es', 'en', 'ru', 'uk'];
export const IDIOMA_POR_DEFECTO: Idioma = 'es';

export function idiomaValido(lang: unknown): Idioma {
    return IDIOMAS.includes(lang as Idioma) ? (lang as Idioma) : IDIOMA_POR_DEFECTO;
}

// ─── Los motivos que la pantalla puede recibir ───────────────────────────────────────────
//
// Conjunto CERRADO, y es la lista de `MOTIVOS` de services/reserva-web.js MENOS 'ok' MÁS
// 'no_encontrado' (el 404 que sirve `noHayNada` en webhook.js, y que la capa del Next repite
// cuando no hay secreto configurado) y 'sin_conexion' (que no lo manda nadie: lo pone la
// propia pantalla cuando el `fetch` ni siquiera llega a contestar).
//
// Un motivo que llegue y no esté aquí NO se pinta en crudo ni se traga: cae en
// 'error_interno', que sí tiene texto y salida. Es la regla 3 aplicada a una pantalla: lo
// que no se resuelve no se inventa.
export type Motivo =
    | 'hueco_ocupado' | 'fuera_de_horario' | 'bloqueado' | 'tope_citas' | 'rango_invalido'
    | 'demasiadas_peticiones' | 'salon_saturado' | 'no_confirmable_online'
    | 'datos_invalidos' | 'servicio_no_disponible' | 'hueco_no_existe' | 'cerrado'
    | 'error_interno' | 'no_encontrado' | 'sin_conexion';

/** A dónde vuelve la clienta después de leer el aviso. */
export type Vuelta =
    | 'huecos'     // a elegir otra hora del mismo día (con los huecos recargados)
    | 'dias'       // a elegir otro día
    | 'servicio'   // a empezar por el servicio
    | 'datos'      // a corregir nombre y teléfono
    | 'reintentar' // se queda donde está y puede volver a darle
    | 'ninguna';   // no hay nada que pueda hacer sola: WhatsApp o nada

export type TextoMotivo = { titulo: string; cuerpo: string; vuelta: Vuelta };

// ─── La tabla de textos ──────────────────────────────────────────────────────────────────

export type Textos = {
    // Cabecera y pasos
    titulo: string;
    cargando: string;
    volver: string;
    pasoServicio: string;
    pasoVariante: string;
    pasoDia: string;
    pasoHora: string;
    pasoDatos: string;
    de: string;                       // «paso 2 DE 5»
    paso: string;
    // Servicio
    elegirServicio: string;
    elegirVariante: string;
    desde: string;                    // «desde 60 €»
    precioEnSalon: string;
    minutos: string;                  // «60 min»
    horas: string;                    // «4 h»
    opciones: string;                 // «5 opciones»
    // Día y hora
    elegirDia: string;
    elegirHora: string;
    sinDias: string;
    sinHoras: string;
    otroDia: string;
    mesAnterior: string;
    mesSiguiente: string;
    meses: string[];                  // 12, en nominativo suelto
    inicialesDias: string[];          // 7, empezando en lunes
    // Datos
    tuNombre: string;
    tuNombreAyuda: string;
    tuTelefono: string;
    tuTelefonoAyuda: string;
    nombreCorto: string;
    telefonoRaro: string;
    confirmar: string;
    confirmando: string;
    resumen: string;
    // Confirmación
    confirmadaTitulo: string;         // lleva {salon}
    confirmadaSinSalon: string;
    conQuien: string;                 // «con Irina»
    avisoRecordatorio: string;
    // Salidas
    escribirWhatsApp: string;
    reintentar: string;
    esperaMinutos: string;            // lleva {min}
    esperaSegundos: string;           // lleva {seg}
    // Motivos
    motivos: Record<Motivo, TextoMotivo>;
};

const ES: Textos = {
    titulo: 'Pedir cita',
    cargando: 'Un momento…',
    volver: 'Atrás',
    pasoServicio: 'Servicio',
    pasoVariante: 'Opción',
    pasoDia: 'Día',
    pasoHora: 'Hora',
    pasoDatos: 'Tus datos',
    de: 'de',
    paso: 'Paso',

    elegirServicio: '¿Qué te quieres hacer?',
    elegirVariante: 'Elige la opción que te encaje',
    desde: 'desde',
    precioEnSalon: 'se confirma en el salón',
    minutos: 'min',
    horas: 'h',
    opciones: 'opciones',

    elegirDia: '¿Qué día te viene bien?',
    elegirHora: '¿A qué hora?',
    sinDias: 'No quedan huecos libres en los próximos meses. Escríbenos y te buscamos sitio.',
    sinHoras: 'Ese día se ha quedado sin huecos. Prueba con otro.',
    otroDia: 'Elegir otro día',
    mesAnterior: 'Mes anterior',
    mesSiguiente: 'Mes siguiente',
    meses: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
            'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    inicialesDias: ['L', 'M', 'X', 'J', 'V', 'S', 'D'],

    tuNombre: 'Tu nombre',
    tuNombreAyuda: 'Para saber a quién esperamos',
    tuTelefono: 'Tu móvil',
    tuTelefonoAyuda: 'Te avisamos por WhatsApp el día antes',
    nombreCorto: 'Escribe tu nombre',
    telefonoRaro: 'Repasa el número: parece que falta algún dígito',
    confirmar: 'Confirmar la cita',
    confirmando: 'Confirmando…',
    resumen: 'Tu cita',

    confirmadaTitulo: 'Tu cita ha sido confirmada en {salon}',
    confirmadaSinSalon: 'Tu cita ha sido confirmada',
    conQuien: 'con',
    avisoRecordatorio: 'Te llegará un recordatorio por WhatsApp 24 horas antes.',

    escribirWhatsApp: 'Escribirnos por WhatsApp',
    reintentar: 'Volver a intentarlo',
    esperaMinutos: 'Prueba otra vez dentro de {min} min.',
    esperaSegundos: 'Prueba otra vez dentro de {seg} segundos.',

    motivos: {
        // ── Los cuatro que devuelve `reservar_hueco()` ──────────────────────────────────
        hueco_ocupado: {
            titulo: 'Ese hueco se acaba de ocupar',
            cuerpo: 'Alguien lo ha cogido mientras elegías. Estas son las horas que quedan libres ese día.',
            vuelta: 'huecos',
        },
        fuera_de_horario: {
            titulo: 'Esa hora ya no está disponible',
            cuerpo: 'El horario ha cambiado mientras reservabas. Estas son las horas que quedan libres.',
            vuelta: 'huecos',
        },
        bloqueado: {
            titulo: 'Ese día ya no está disponible',
            cuerpo: 'El salón ha cerrado esa franja. Elige otro día y te enseñamos las horas.',
            vuelta: 'dias',
        },
        // NO recarga huecos, y eso es una decisión: enseñarle otra vez lo mismo que acaba de
        // no poder reservar no la ayuda. Lo que la ayuda es hablar con el salón.
        tope_citas: {
            titulo: 'Ya tienes dos citas pedidas',
            cuerpo: 'Por aquí no podemos apuntarte una tercera. Escríbenos por WhatsApp y te la reservamos nosotras.',
            vuelta: 'ninguna',
        },

        // ── El resto ────────────────────────────────────────────────────────────────────
        hueco_no_existe: {
            titulo: 'Esa hora ya no está libre',
            cuerpo: 'Elige otra entre las que quedan.',
            vuelta: 'huecos',
        },
        demasiadas_peticiones: {
            titulo: 'Demasiados intentos seguidos',
            cuerpo: 'Espera un poco y vuelve a probar. Si tienes prisa, escríbenos por WhatsApp.',
            vuelta: 'ninguna',
        },
        salon_saturado: {
            titulo: 'Ahora mismo no podemos confirmar más citas',
            cuerpo: 'Inténtalo dentro de un rato o escríbenos por WhatsApp.',
            vuelta: 'ninguna',
        },
        // Lista negra. NEUTRO a propósito: en el salón bloquear es silencio, pero una página
        // tiene que pintar algo, y ese algo no puede ser «estás bloqueada». Comparte forma
        // con el resto de «esto no se cierra por internet».
        no_confirmable_online: {
            titulo: 'No podemos confirmar esta cita por internet',
            cuerpo: 'Escríbenos por WhatsApp y lo vemos contigo.',
            vuelta: 'ninguna',
        },
        cerrado: {
            titulo: 'Las citas por internet están cerradas',
            cuerpo: 'Escríbenos por WhatsApp y te damos hora.',
            vuelta: 'ninguna',
        },
        servicio_no_disponible: {
            titulo: 'Ese servicio no se puede reservar por aquí',
            cuerpo: 'Elige otro de la lista, o escríbenos por WhatsApp y te asesoramos.',
            vuelta: 'servicio',
        },
        datos_invalidos: {
            titulo: 'Repasa tus datos',
            cuerpo: 'Hay algo que no cuadra en el nombre o en el teléfono.',
            vuelta: 'datos',
        },
        // `rango_invalido` es culpa NUESTRA (el javascript construyó mal el rango). No se le
        // pide a la clienta que arregle algo que no ha hecho.
        rango_invalido: {
            titulo: 'No hemos podido confirmar la cita',
            cuerpo: 'Ha sido un fallo nuestro. Escríbenos por WhatsApp y te la apuntamos a mano.',
            vuelta: 'ninguna',
        },
        error_interno: {
            titulo: 'No hemos podido confirmar la cita',
            cuerpo: 'Vuelve a intentarlo en un momento. Si sigue sin funcionar, escríbenos por WhatsApp.',
            vuelta: 'reintentar',
        },
        sin_conexion: {
            titulo: 'No hemos podido conectar',
            cuerpo: 'Comprueba tu conexión y vuelve a intentarlo.',
            vuelta: 'reintentar',
        },
        no_encontrado: {
            titulo: 'Esta página no existe',
            cuerpo: 'Puede que el enlace esté mal copiado o que ya no esté activo.',
            vuelta: 'ninguna',
        },
    },
};

/**
 * Las tablas por idioma. Hoy solo 'es' — y que las otras tres FALTEN es información, no un
 * descuido: `textos()` cae a castellano entero y la pantalla nunca queda con huecos.
 */
export const TEXTOS: Partial<Record<Idioma, Textos>> = { es: ES };

export function textos(lang: unknown): Textos {
    return TEXTOS[idiomaValido(lang)] ?? ES;
}

/** Sustituye `{clave}` por su valor. Sin plantillas ni librerías: son cuatro cadenas. */
export function rellenar(plantilla: string, valores: Record<string, string>): string {
    return plantilla.replace(/\{(\w+)\}/g, (todo, clave) =>
        Object.prototype.hasOwnProperty.call(valores, clave) ? valores[clave] : todo);
}

// ─── Leer una respuesta que dice que no ──────────────────────────────────────────────────

export type Fallo = {
    motivo: Motivo;
    /** Lo dice la RESPUESTA (`recargarHuecos`), no una copia de la política. */
    recargarHuecos: boolean;
    whatsapp: string | null;
    esperaSegundos: number | null;
};

const MOTIVOS_CONOCIDOS = new Set<string>(Object.keys(ES.motivos));

/**
 * Traduce lo que devolvió el endpoint a lo que la pantalla tiene que hacer.
 *
 * El `estado` HTTP entra pero NO manda: quien manda es el motivo, que es de conjunto
 * cerrado. Un cuerpo que no se entiende —Express caído devolviendo HTML, un proxy metiendo
 * una página de error— cae en 'error_interno', que tiene texto y salida. Lo que nunca pasa
 * es que la clienta vea una cadena en crudo del servidor.
 */
export function interpretarFallo(estado: number, cuerpo: unknown): Fallo {
    const c = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as Record<string, unknown>;
    const crudo = typeof c.motivo === 'string' ? c.motivo : '';
    const motivo = (MOTIVOS_CONOCIDOS.has(crudo) ? crudo : 'error_interno') as Motivo;

    // El enlace de WhatsApp lo fabrica NUESTRO servidor, pero se comprueba igual antes de
    // meterlo en un href: una respuesta es texto de la red, y un `href` es la única cosa de
    // esta pantalla en la que un valor cualquiera se convierte en una acción.
    const url = typeof c.whatsapp === 'string' && c.whatsapp.startsWith('https://wa.me/')
        ? c.whatsapp : null;

    const espera = typeof c.esperaSegundos === 'number'
        && Number.isFinite(c.esperaSegundos) && c.esperaSegundos >= 0
        ? Math.ceil(c.esperaSegundos) : null;

    return {
        motivo,
        recargarHuecos: c.recargarHuecos === true,
        whatsapp: url,
        esperaSegundos: espera,
        // `estado` se ignora a propósito: el 409 de un hueco ocupado y el 409 de un tope de
        // citas se pintan distinto, y lo que los separa es el motivo. Queda en la firma
        // porque quien llama lo tiene y porque un motivo ausente con estado 200 sería un
        // caso que hoy no existe pero que conviene poder distinguir mañana.
    };
}

/** «Prueba otra vez dentro de 3 min» — sin prometer un reloj que no controlamos. */
export function textoEspera(t: Textos, segundos: number | null): string | null {
    if (segundos === null || !Number.isFinite(segundos) || segundos <= 0) return null;
    if (segundos < 90) return rellenar(t.esperaSegundos, { seg: String(Math.ceil(segundos)) });
    return rellenar(t.esperaMinutos, { min: String(Math.ceil(segundos / 60)) });
}

// ─── El catálogo, agrupado para la pantalla ──────────────────────────────────────────────

export type EntradaCatalogo = {
    key: string;            // `categoria|nombre`, la clave que viaja al servidor
    categoria: string | null;
    nombre: string | null;
    precio: number | null;  // null = «se confirma en el salón». NUNCA se pinta como 0 €.
    duracion: number | null;
};

export type GrupoServicio = {
    categoria: string;
    entradas: EntradaCatalogo[];
    /** Precio más bajo del grupo, o null si NINGUNA entrada tiene precio. */
    desde: number | null;
    /** true cuando alguna entrada no tiene precio: entonces «desde» no cuenta la historia. */
    algunoSinPrecio: boolean;
};

/**
 * Agrupa por categoría conservando el ORDEN en que vienen del servidor, que es el que la
 * dueña ve en el panel. Ordenar aquí por precio o por alfabeto sería reordenarle el
 * escaparate a alguien que no ha pedido que se lo reordenen.
 *
 * Una entrada sin `key` o sin categoría se DESCARTA y se cuenta: sin clave no se puede
 * reservar (el servidor la resuelve por `categoria|nombre`), así que pintarla sería un botón
 * que no lleva a ningún sitio.
 */
export function agruparCatalogo(servicios: unknown): { grupos: GrupoServicio[]; descartadas: number } {
    const lista = Array.isArray(servicios) ? servicios : [];
    const porCategoria = new Map<string, GrupoServicio>();
    let descartadas = 0;

    for (const bruto of lista) {
        const s = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
        const key = typeof s.key === 'string' ? s.key : '';
        const categoria = typeof s.categoria === 'string' ? s.categoria : '';
        const nombre = typeof s.nombre === 'string' ? s.nombre : '';
        if (!key || !categoria || !nombre) { descartadas += 1; continue; }

        const precio = typeof s.precio === 'number' && Number.isFinite(s.precio) ? s.precio : null;
        const duracion = typeof s.duracion === 'number' && Number.isFinite(s.duracion) ? s.duracion : null;

        let grupo = porCategoria.get(categoria);
        if (!grupo) {
            grupo = { categoria, entradas: [], desde: null, algunoSinPrecio: false };
            porCategoria.set(categoria, grupo);
        }
        grupo.entradas.push({ key, categoria, nombre, precio, duracion });
        if (precio === null) grupo.algunoSinPrecio = true;
        else if (grupo.desde === null || precio < grupo.desde) grupo.desde = precio;
    }

    return { grupos: [...porCategoria.values()], descartadas };
}

/** «35 €» · «se confirma en el salón» si no hay precio. Un 0 € inventado no sale de aquí. */
export function formatearPrecio(precio: number | null, t: Textos): string {
    if (precio === null || !Number.isFinite(precio)) return t.precioEnSalon;
    const entero = Number.isInteger(precio) ? String(precio) : precio.toFixed(2).replace('.', ',');
    return `${entero} €`;
}

/** «45 min» · «4 h» · «4 h 30 min». Devuelve null si no hay duración: no se inventa. */
export function formatearDuracion(min: number | null, t: Textos): string | null {
    if (min === null || !Number.isFinite(min) || min <= 0) return null;
    if (min < 60) return `${min} ${t.minutos}`;
    const h = Math.floor(min / 60);
    const resto = min % 60;
    return resto ? `${h} ${t.horas} ${resto} ${t.minutos}` : `${h} ${t.horas}`;
}

// ─── La rejilla de días ──────────────────────────────────────────────────────────────────

export type DiaConHueco = { fecha: string; huecos: number };

export type Casilla = {
    fecha: string | null;   // null = hueco de relleno al principio del mes
    dia: number;
    huecos: number;         // 0 = no se puede elegir
    elegible: boolean;
};

export type Mes = { anio: number; mes: number; casillas: Casilla[] };

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El HOY del SALÓN, no el del móvil de la clienta.
 *
 * Una clienta en otro huso (o con el móvil mal puesto) vería el calendario corrido un día y
 * podría pedir una fecha que para el salón ya pasó. Es el primo de D2, y el sitio donde el
 * repo ya se lo encontró: las horas de trabajo son hora de PARED de Madrid.
 *
 * 'en-CA' porque da exactamente `YYYY-MM-DD`, que es la forma en la que hablan los endpoints.
 */
export function hoyEnElSalon(ahora: Date = new Date(), tz = 'Europe/Madrid'): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ahora);
}

function aUTC(fecha: string): Date | null {
    if (!FECHA_RE.test(fecha)) return null;
    const [y, m, d] = fecha.split('-').map(Number);
    // Mediodía UTC, el mismo ancla que formatReminderWhen: la fecha de una cita es un día de
    // calendario, no un instante, y así ningún huso puede moverlo.
    const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return t;
}

function comoFecha(t: Date): string {
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Construye los meses que hay que poder hojear: del mes de HOY al mes en el que cae el
 * final del horizonte. Una casilla es elegible SOLO si el servidor la ha devuelto con
 * huecos — la rejilla no deduce disponibilidad, la pinta.
 *
 * La semana empieza en LUNES (`(getUTCDay() + 6) % 7`), como `stylist_schedules`.
 */
export function construirMeses(hoy: string, horizonteDias: number, dias: DiaConHueco[]): Mes[] {
    const inicio = aUTC(hoy);
    if (!inicio) return [];

    const conHueco = new Map<string, number>();
    for (const d of dias || []) {
        if (d && typeof d.fecha === 'string' && FECHA_RE.test(d.fecha)) {
            const n = typeof d.huecos === 'number' && Number.isFinite(d.huecos) ? d.huecos : 0;
            if (n > 0) conHueco.set(d.fecha, n);
        }
    }

    const fin = new Date(inicio.getTime());
    fin.setUTCDate(fin.getUTCDate() + Math.max(0, horizonteDias));

    const meses: Mes[] = [];
    const cursor = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth(), 1, 12, 0, 0));
    while (cursor.getUTCFullYear() < fin.getUTCFullYear()
        || (cursor.getUTCFullYear() === fin.getUTCFullYear() && cursor.getUTCMonth() <= fin.getUTCMonth())) {
        const anio = cursor.getUTCFullYear();
        const mes = cursor.getUTCMonth();
        const primero = new Date(Date.UTC(anio, mes, 1, 12, 0, 0));
        const relleno = (primero.getUTCDay() + 6) % 7;
        const ultimoDia = new Date(Date.UTC(anio, mes + 1, 0, 12, 0, 0)).getUTCDate();

        const casillas: Casilla[] = [];
        for (let i = 0; i < relleno; i += 1) casillas.push({ fecha: null, dia: 0, huecos: 0, elegible: false });
        for (let d = 1; d <= ultimoDia; d += 1) {
            const fecha = comoFecha(new Date(Date.UTC(anio, mes, d, 12, 0, 0)));
            const huecos = conHueco.get(fecha) ?? 0;
            casillas.push({ fecha, dia: d, huecos, elegible: huecos > 0 });
        }
        meses.push({ anio, mes, casillas });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return meses;
}

/** El índice del primer mes que tiene algún día elegible. -1 si no hay ninguno. */
export function primerMesConHueco(meses: Mes[]): number {
    return meses.findIndex(m => m.casillas.some(c => c.elegible));
}

// ─── Lo que teclea la clienta ────────────────────────────────────────────────────────────

/**
 * El teléfono. Aquí NO se replica `sanitizePhone` —la forma canónica la decide el servidor,
 * que es quien escribe en `contacts`— y esto solo evita el viaje: 9 dígitos o más una vez
 * quitados espacios, guiones y el prefijo. Falla hacia el lado permisivo a propósito: un
 * número extranjero raro tiene que poder reservar, y si de verdad no vale, el servidor
 * devuelve `datos_invalidos` y la pantalla lo dice.
 */
export function telefonoUsable(txt: unknown): boolean {
    const digitos = String(txt ?? '').replace(/\D/g, '');
    return digitos.length >= 9 && digitos.length <= 15;
}

export function nombreUsable(txt: unknown): boolean {
    return String(txt ?? '').trim().length >= 2;
}
