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

/**
 * El nombre de cada idioma, EN SU PROPIO IDIOMA. No entra en `Textos` y no se traduce: quien
 * busca su idioma en una lista busca la palabra que reconoce, no su traducción. Es la razón
 * por la que ningún selector del mundo pone «Ruso» en la versión castellana.
 */
export const NOMBRES_IDIOMA: Record<Idioma, string> = {
    es: 'Español', en: 'English', ru: 'Русский', uk: 'Українська',
};

export function idiomaValido(lang: unknown): Idioma {
    return IDIOMAS.includes(lang as Idioma) ? (lang as Idioma) : IDIOMA_POR_DEFECTO;
}

/**
 * De dónde sale el idioma de la pantalla, en este orden y solo este:
 *
 *   1. **La URL** (`?lang=ru`). Manda siempre, porque es lo único que la clienta puede
 *      cambiar a mano — y hace falta poder: una ucraniana con el móvil configurado en ruso
 *      existe, y es exactamente a quien el navegador engañaría.
 *   2. **El navegador** (`Accept-Language`), respetando el orden de preferencia y su `q`.
 *      Se compara solo la subetiqueta principal: `ru-RU`, `ru-UA` y `ru` son el mismo ruso.
 *   3. **Castellano.** Sin señal no se adivina, y es el idioma del salón.
 *
 * Un `?lang=` que no existe NO cae directo a castellano: se ignora y sigue la cascada, que
 * es lo que hace que un enlace mal copiado («?lang=rus») siga dando el idioma del navegador
 * en vez de castellano a una rusa.
 *
 * Devuelve también el ORIGEN. No cambia lo que se pinta; sirve para que la decisión se pueda
 * probar y para saber, al mirar un caso raro, si el idioma lo eligió ella o lo dedujimos.
 */
export function elegirIdioma(
    { url, aceptaIdiomas }: { url?: unknown; aceptaIdiomas?: unknown } = {},
): { idioma: Idioma; origen: 'url' | 'navegador' | 'defecto' } {
    if (typeof url === 'string' && IDIOMAS.includes(url.trim().toLowerCase() as Idioma)) {
        return { idioma: url.trim().toLowerCase() as Idioma, origen: 'url' };
    }
    const cabecera = typeof aceptaIdiomas === 'string' ? aceptaIdiomas : '';
    const preferencias = cabecera
        .split(',')
        .map((trozo, i) => {
            const [etiqueta, ...params] = trozo.trim().split(';');
            const q = params.map(x => /^q=([\d.]+)$/.exec(x.trim())).find(Boolean);
            // El orden de aparición desempata cuando dos tienen la misma q, que es lo que
            // hace Chrome: manda `ru,uk;q=0.9` y espera ruso.
            return { base: etiqueta.trim().toLowerCase().split('-')[0], q: q ? Number(q[1]) : 1, i };
        })
        .filter(x => Number.isFinite(x.q) && x.q > 0)
        .sort((a, b) => (b.q - a.q) || (a.i - b.i));
    for (const p of preferencias) {
        if (IDIOMAS.includes(p.base as Idioma)) return { idioma: p.base as Idioma, origen: 'navegador' };
    }
    return { idioma: IDIOMA_POR_DEFECTO, origen: 'defecto' };
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
    | 'error_interno' | 'no_encontrado' | 'sin_conexion' | 'hueco_caducado';

/** A dónde vuelve la clienta después de leer el aviso. */
export type Vuelta =
    | 'huecos'     // a elegir otra hora del mismo día (con los huecos recargados)
    | 'dias'       // a elegir otro día
    | 'servicio'   // a empezar por el servicio
    | 'datos'      // a corregir nombre y teléfono
    | 'reintentar' // se queda donde está y puede volver a darle
    | 'ninguna';   // no hay nada que pueda hacer sola: WhatsApp o nada

export type TextoMotivo = { titulo: string; cuerpo: string };

/**
 * A dónde vuelve la clienta después de cada aviso. **Una sola tabla, sin idioma**, y eso es
 * lo importante: si `vuelta` viviera dentro de la tabla de textos, habría cuatro copias y
 * cambiar una sin las otras haría que la pantalla se COMPORTARA distinto en ruso que en
 * castellano — un fallo que no se ve leyendo, porque las cuatro tablas están una debajo de
 * otra y parecen lo mismo. El texto se traduce; la conducta no.
 */
const VUELTAS: Record<Motivo, Vuelta> = {
    // La agenda ha cambiado: se recargan los huecos y se vuelve a elegir hora.
    hueco_ocupado: 'huecos',
    fuera_de_horario: 'huecos',
    hueco_no_existe: 'huecos',
    // El día entero se ha cerrado: al calendario, no a una lista vacía.
    bloqueado: 'dias',
    // El tope NO recarga: enseñarle otra vez lo que acaba de no poder reservar no la ayuda.
    tope_citas: 'ninguna',
    demasiadas_peticiones: 'ninguna',
    salon_saturado: 'ninguna',
    no_confirmable_online: 'ninguna',
    cerrado: 'ninguna',
    no_encontrado: 'ninguna',
    // Culpa nuestra: no se le pide que arregle algo que no ha hecho.
    rango_invalido: 'ninguna',
    servicio_no_disponible: 'servicio',
    datos_invalidos: 'datos',
    error_interno: 'reintentar',
    sin_conexion: 'reintentar',
    // No lo manda nadie: lo pone la pantalla cuando vuelve de una recarga y el hueco que
    // ella tenía elegido ya no está en la agenda. Va a 'huecos' porque para entonces la
    // lista del día ya se ha releído y lo que hay debajo del aviso son los que quedan.
    hueco_caducado: 'huecos',
};

export function vueltaDe(motivo: Motivo): Vuelta {
    return VUELTAS[motivo] ?? VUELTAS.error_interno;
}

// ─── La tabla de textos ──────────────────────────────────────────────────────────────────

export type Textos = {
    // Cabecera y pasos
    titulo: string;
    cargando: string;
    volver: string;
    /**
     * Qué HACE el control de la cabecera. Antes ahí solo ponía «ES» y su `aria-label` decía
     * «Español», que es lo que está elegido y no lo que pasa si lo tocas. El nombre del
     * idioma en su propio idioma sigue viniendo de `NOMBRES_IDIOMA`, que no se traduce.
     */
    idioma: string;
    pasoServicio: string;
    pasoVariante: string;
    pasoDia: string;
    pasoHora: string;
    pasoDatos: string;
    de: string;                       // «paso 2 DE 5»
    paso: string;
    // Servicio
    elegirServicio: string;
    // Las dos salidas voluntarias del primer paso
    otrasOpciones: string;
    puertaAsesoramiento: string;
    puertaVariasPersonas: string;
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
    // Las iniciales SÍ son una tabla: el narrow de ICU en castellano repite «M» para martes
    // y miércoles, y el salón escribe la X de toda la vida.
    inicialesDias: string[];          // 7, empezando en lunes
    // Datos
    tuNombre: string;
    tuNombreAyuda: string;
    tuTelefono: string;
    tuTelefonoAyuda: string;
    /** El desplegable del prefijo. No se pinta como etiqueta —la del campo entero es
     *  `tuTelefono`— pero sí se ANUNCIA: un lector de pantalla encuentra dos controles
     *  seguidos y sin esto el primero no dice qué es. El NOMBRE de cada país no está aquí:
     *  lo pone el navegador (`nombrePais`). */
    tuPais: string;
    nombreCorto: string;
    telefonoProblema: Record<ProblemaTelefono, string>;
    confirmar: string;
    confirmando: string;
    resumen: string;
    // Confirmación
    confirmadaTitulo: string;         // lleva {salon}
    confirmadaSinSalon: string;
    // ETIQUETA, no preposición. «con Irina» exigiría un conector por idioma, y ese conector
    // ya existe DOS veces en helpers.js y NO coinciden: `SLOT_TEXTO_PARTES` dice «с/з» y
    // `_lineaCita` dice «у/у» para lo mismo. Una tercera copia aquí, encima en un sitio que
    // no puede importar helpers, es la forma segura de equivocarse. Una etiqueta no declina.
    estilistaEtiqueta: string;        // «Estilista: Irina»
    avisoRecordatorio: string;
    // Cuando lo que falla es ABRIR la página, no reservar
    noSeHaPodidoAbrir: { titulo: string; cuerpo: string };
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
    idioma: 'Idioma',
    pasoServicio: 'Servicio',
    pasoVariante: 'Opción',
    pasoDia: 'Día',
    pasoHora: 'Hora',
    pasoDatos: 'Tus datos',
    de: 'de',
    paso: 'Paso',

    elegirServicio: '¿Qué te quieres hacer?',
    otrasOpciones: '¿No es tu caso?',
    puertaAsesoramiento: 'No lo tengo claro, que me asesoren',
    puertaVariasPersonas: 'Somos dos o más',
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
    inicialesDias: ['L', 'M', 'X', 'J', 'V', 'S', 'D'],

    tuNombre: 'Tu nombre',
    tuNombreAyuda: 'Para saber a quién esperamos',
    tuTelefono: 'Tu móvil',
    tuTelefonoAyuda: 'Te avisamos por WhatsApp el día antes',
    tuPais: 'País',
    nombreCorto: 'Escribe tu nombre',
    telefonoProblema: {
        letras: 'El teléfono va solo con números',
        corto:  'Repasa el número: parece que falta algún dígito',
        largo:  'Repasa el número: tiene dígitos de más',
    },
    confirmar: 'Confirmar la cita',
    confirmando: 'Confirmando…',
    resumen: 'Tu cita',

    confirmadaTitulo: 'Tu cita ha sido confirmada en {salon}',
    confirmadaSinSalon: 'Tu cita ha sido confirmada',
    estilistaEtiqueta: 'Estilista',
    avisoRecordatorio: 'Te llegará un recordatorio por WhatsApp 24 horas antes.',

    noSeHaPodidoAbrir: {
        titulo: 'No hemos podido abrir las citas',
        cuerpo: 'Puede ser cosa de la conexión. Vuelve a intentarlo en un momento.',
    },

    escribirWhatsApp: 'Escribirnos por WhatsApp',
    reintentar: 'Volver a intentarlo',
    esperaMinutos: 'Prueba otra vez dentro de {min} min.',
    esperaSegundos: 'Prueba otra vez dentro de {seg} segundos.',

    motivos: {
        // ── Los cuatro que devuelve `reservar_hueco()` ──────────────────────────────────
        hueco_ocupado: {
            titulo: 'Ese hueco se acaba de ocupar',
            cuerpo: 'Alguien lo ha cogido mientras elegías. Estas son las horas que quedan libres ese día.',
        },
        fuera_de_horario: {
            titulo: 'Esa hora ya no está disponible',
            cuerpo: 'El horario ha cambiado mientras reservabas. Estas son las horas que quedan libres.',
        },
        bloqueado: {
            titulo: 'Ese día ya no está disponible',
            cuerpo: 'El salón ha cerrado esa franja. Elige otro día y te enseñamos las horas.',
        },
        // NO recarga huecos, y eso es una decisión: enseñarle otra vez lo mismo que acaba de
        // no poder reservar no la ayuda. Lo que la ayuda es hablar con el salón.
        tope_citas: {
            titulo: 'Ya tienes dos citas pedidas',
            cuerpo: 'Por aquí no podemos apuntarte una tercera. Escríbenos por WhatsApp y te la reservamos nosotras.',
        },

        // ── El resto ────────────────────────────────────────────────────────────────────
        hueco_no_existe: {
            titulo: 'Esa hora ya no está libre',
            cuerpo: 'Elige otra entre las que quedan.',
        },
        demasiadas_peticiones: {
            titulo: 'Demasiados intentos seguidos',
            cuerpo: 'Espera un poco y vuelve a probar. Si tienes prisa, escríbenos por WhatsApp.',
        },
        salon_saturado: {
            titulo: 'Ahora mismo no podemos confirmar más citas',
            cuerpo: 'Inténtalo dentro de un rato o escríbenos por WhatsApp.',
        },
        // Lista negra. NEUTRO a propósito: en el salón bloquear es silencio, pero una página
        // tiene que pintar algo, y ese algo no puede ser «estás bloqueada». Comparte forma
        // con el resto de «esto no se cierra por internet».
        no_confirmable_online: {
            titulo: 'No podemos confirmar esta cita por internet',
            cuerpo: 'Escríbenos por WhatsApp y lo vemos contigo.',
        },
        cerrado: {
            titulo: 'Las citas por internet están cerradas',
            cuerpo: 'Escríbenos por WhatsApp y te damos hora.',
        },
        servicio_no_disponible: {
            titulo: 'Ese servicio no se puede reservar por aquí',
            cuerpo: 'Elige otro de la lista, o escríbenos por WhatsApp y te asesoramos.',
        },
        datos_invalidos: {
            titulo: 'Repasa tus datos',
            cuerpo: 'Hay algo que no cuadra en el nombre o en el teléfono.',
        },
        // `rango_invalido` es culpa NUESTRA (el javascript construyó mal el rango). No se le
        // pide a la clienta que arregle algo que no ha hecho.
        rango_invalido: {
            titulo: 'No hemos podido confirmar la cita',
            cuerpo: 'Ha sido un fallo nuestro. Escríbenos por WhatsApp y te la apuntamos a mano.',
        },
        error_interno: {
            titulo: 'No hemos podido confirmar la cita',
            cuerpo: 'Vuelve a intentarlo en un momento. Si sigue sin funcionar, escríbenos por WhatsApp.',
        },
        sin_conexion: {
            titulo: 'No hemos podido conectar',
            cuerpo: 'Comprueba tu conexión y vuelve a intentarlo.',
        },
        hueco_caducado: {
            titulo: 'Esa hora ya no está libre',
            cuerpo: 'La ha cogido otra persona mientras tanto. Estas son las que quedan.',
        },
        no_encontrado: {
            titulo: 'Esta página no existe',
            cuerpo: 'Puede que el enlace esté mal copiado o que ya no esté activo.',
        },
    },
};


/**
 * ── Las otras tres tablas ────────────────────────────────────────────────────────────────
 *
 * Lo que NO se traduce aquí, y no por olvido:
 *
 *   · **La fecha en palabras.** «12:30 del sábado 22 de agosto» llega HECHA del servidor en
 *     `cita.cuando` (`formatReminderWhen`), que es el mismo formateador del recordatorio de
 *     24 h y el único sitio del sistema con el acusativo ruso y ucraniano resuelto («во
 *     вторник», no «вторник»). El rótulo suelto de la rejilla sale de `Intl`, que da
 *     nominativo, que es lo que un título necesita. Escribir aquí una tercera forma de decir
 *     la misma fecha es exactamente lo que CLAUDE.md prohíbe.
 *   · **Los mensajes de WhatsApp.** Los de las dos puertas y los de cada motivo los redacta
 *     `services/reserva-web.js` en los cuatro idiomas y llegan como URL ya montada. La
 *     pantalla no escribe ni uno.
 *   · **Los nombres de servicio.** El catálogo está en castellano y así lo lee la clienta en
 *     el salón, en la factura y en el WhatsApp de la dueña. Traducir «Mechas Balayage» sería
 *     que no lo reconociera al llegar.
 *
 * Y el TRATO es de tú en los cuatro, como el resto de lo que el salón le dice a una clienta:
 * el bot ya le escribe «Опиши, пожалуйста, что ты хочешь сделать» a una desconocida en su
 * primer mensaje. Una pantalla en «вы» y un WhatsApp en «ты» del mismo salón, el mismo día,
 * suenan a dos sitios distintos.
 */
const EN: Textos = {
    titulo: 'Book an appointment',
    cargando: 'One moment…',
    volver: 'Back',
    idioma: 'Language',
    pasoServicio: 'Service',
    pasoVariante: 'Option',
    pasoDia: 'Day',
    pasoHora: 'Time',
    pasoDatos: 'Your details',
    de: 'of',
    paso: 'Step',

    elegirServicio: 'What would you like done?',
    otrasOpciones: 'Not quite your case?',
    puertaAsesoramiento: 'I am not sure — I would like advice',
    puertaVariasPersonas: 'There are two or more of us',
    elegirVariante: 'Pick the option that fits you',
    desde: 'from',
    precioEnSalon: 'confirmed at the salon',
    minutos: 'min',
    horas: 'h',
    opciones: 'options',

    elegirDia: 'Which day suits you?',
    elegirHora: 'What time?',
    sinDias: 'There are no free slots in the coming months. Message us and we will find you a time.',
    sinHoras: 'That day has no slots left. Try another one.',
    otroDia: 'Choose another day',
    mesAnterior: 'Previous month',
    mesSiguiente: 'Next month',
    inicialesDias: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],

    tuNombre: 'Your name',
    tuNombreAyuda: 'So we know who to expect',
    tuTelefono: 'Your mobile',
    tuTelefonoAyuda: 'We will remind you on WhatsApp the day before',
    tuPais: 'Country',
    nombreCorto: 'Please write your name',
    telefonoProblema: {
        letras: 'Phone numbers are digits only',
        corto:  'Check the number — a digit seems to be missing',
        largo:  'Check the number — it has too many digits',
    },
    confirmar: 'Confirm the appointment',
    confirmando: 'Confirming…',
    resumen: 'Your appointment',

    confirmadaTitulo: 'Your appointment at {salon} is confirmed',
    confirmadaSinSalon: 'Your appointment is confirmed',
    estilistaEtiqueta: 'Stylist',
    avisoRecordatorio: 'You will get a WhatsApp reminder 24 hours before.',

    noSeHaPodidoAbrir: {
        titulo: 'We could not open the booking page',
        cuerpo: 'It may be your connection. Please try again in a moment.',
    },

    escribirWhatsApp: 'Message us on WhatsApp',
    reintentar: 'Try again',
    esperaMinutos: 'Try again in {min} min.',
    esperaSegundos: 'Try again in {seg} seconds.',

    motivos: {
        hueco_ocupado: {
            titulo: 'That slot has just been taken',
            cuerpo: 'Someone booked it while you were choosing. These are the times still free that day.',
        },
        fuera_de_horario: {
            titulo: 'That time is no longer available',
            cuerpo: 'The schedule changed while you were booking. These are the times still free.',
        },
        bloqueado: {
            titulo: 'That day is no longer available',
            cuerpo: 'The salon has closed that slot. Choose another day and we will show you the times.',
        },
        tope_citas: {
            titulo: 'You already have two appointments',
            cuerpo: 'We cannot add a third one here. Message us on WhatsApp and we will book it for you.',
        },
        hueco_no_existe: {
            titulo: 'That time is no longer free',
            cuerpo: 'Pick another one from those left.',
        },
        demasiadas_peticiones: {
            titulo: 'Too many attempts in a row',
            cuerpo: 'Wait a little and try again. If you are in a hurry, message us on WhatsApp.',
        },
        salon_saturado: {
            titulo: 'We cannot confirm more bookings right now',
            cuerpo: 'Try again in a while, or message us on WhatsApp.',
        },
        no_confirmable_online: {
            titulo: 'We cannot confirm this booking online',
            cuerpo: 'Message us on WhatsApp and we will sort it out with you.',
        },
        cerrado: {
            titulo: 'Online booking is closed',
            cuerpo: 'Message us on WhatsApp and we will find you a time.',
        },
        servicio_no_disponible: {
            titulo: 'That service cannot be booked here',
            cuerpo: 'Pick another one from the list, or message us on WhatsApp for advice.',
        },
        datos_invalidos: {
            titulo: 'Check your details',
            cuerpo: 'Something does not look right in the name or the phone number.',
        },
        rango_invalido: {
            titulo: 'We could not confirm the appointment',
            cuerpo: 'That one was on us. Message us on WhatsApp and we will book it by hand.',
        },
        error_interno: {
            titulo: 'We could not confirm the appointment',
            cuerpo: 'Please try again in a moment. If it keeps failing, message us on WhatsApp.',
        },
        sin_conexion: {
            titulo: 'We could not connect',
            cuerpo: 'Check your connection and try again.',
        },
        hueco_caducado: {
            titulo: 'That time is no longer free',
            cuerpo: 'Someone took it in the meantime. These are the ones still open.',
        },
        no_encontrado: {
            titulo: 'This page does not exist',
            cuerpo: 'The link may have been copied wrong, or it may no longer be active.',
        },
    },
};

const RU: Textos = {
    titulo: 'Записаться',
    cargando: 'Одну минуту…',
    volver: 'Назад',
    idioma: 'Язык',
    pasoServicio: 'Услуга',
    pasoVariante: 'Вариант',
    pasoDia: 'День',
    pasoHora: 'Время',
    pasoDatos: 'Твои данные',
    de: 'из',
    paso: 'Шаг',

    elegirServicio: 'Что ты хочешь сделать?',
    otrasOpciones: 'Не твой случай?',
    puertaAsesoramiento: 'Не знаю, что выбрать — нужен совет',
    puertaVariasPersonas: 'Нас двое или больше',
    elegirVariante: 'Выбери подходящий вариант',
    desde: 'от',
    precioEnSalon: 'уточняется в салоне',
    minutos: 'мин',
    horas: 'ч',
    opciones: 'вариантов',

    elegirDia: 'Какой день тебе удобен?',
    elegirHora: 'Во сколько?',
    sinDias: 'В ближайшие месяцы свободных окон нет. Напиши нам, и мы подберём время.',
    sinHoras: 'На этот день свободных окон не осталось. Попробуй другой.',
    otroDia: 'Выбрать другой день',
    mesAnterior: 'Предыдущий месяц',
    mesSiguiente: 'Следующий месяц',
    inicialesDias: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],

    tuNombre: 'Твоё имя',
    tuNombreAyuda: 'Чтобы знать, кого ждём',
    tuTelefono: 'Твой телефон',
    tuTelefonoAyuda: 'Напомним в WhatsApp за день до визита',
    tuPais: 'Страна',
    nombreCorto: 'Напиши своё имя',
    telefonoProblema: {
        letras: 'Номер пишется только цифрами',
        corto:  'Проверь номер: кажется, не хватает цифры',
        largo:  'Проверь номер: в нём лишние цифры',
    },
    confirmar: 'Подтвердить запись',
    confirmando: 'Подтверждаем…',
    resumen: 'Твоя запись',

    confirmadaTitulo: 'Твоя запись в {salon} подтверждена',
    confirmadaSinSalon: 'Твоя запись подтверждена',
    estilistaEtiqueta: 'Мастер',
    avisoRecordatorio: 'За 24 часа до визита придёт напоминание в WhatsApp.',

    noSeHaPodidoAbrir: {
        titulo: 'Не удалось открыть запись',
        cuerpo: 'Возможно, дело в соединении. Попробуй ещё раз через минуту.',
    },

    escribirWhatsApp: 'Написать нам в WhatsApp',
    reintentar: 'Попробовать ещё раз',
    esperaMinutos: 'Попробуй снова через {min} мин.',
    esperaSegundos: 'Попробуй снова через {seg} сек.',

    motivos: {
        hueco_ocupado: {
            titulo: 'Это время только что заняли',
            cuerpo: 'Кто-то записался, пока ты выбирала. Вот часы, которые ещё свободны в этот день.',
        },
        fuera_de_horario: {
            titulo: 'Это время больше недоступно',
            cuerpo: 'Расписание изменилось, пока ты записывалась. Вот часы, которые остались свободными.',
        },
        bloqueado: {
            titulo: 'Этот день больше недоступен',
            cuerpo: 'Салон закрыл это время. Выбери другой день, и мы покажем свободные часы.',
        },
        tope_citas: {
            titulo: 'У тебя уже две записи',
            cuerpo: 'Третью здесь оформить нельзя. Напиши нам в WhatsApp, и мы запишем тебя сами.',
        },
        hueco_no_existe: {
            titulo: 'Это время уже занято',
            cuerpo: 'Выбери другое из оставшихся.',
        },
        demasiadas_peticiones: {
            titulo: 'Слишком много попыток подряд',
            cuerpo: 'Подожди немного и попробуй снова. Если срочно — напиши нам в WhatsApp.',
        },
        salon_saturado: {
            titulo: 'Сейчас мы не можем подтвердить больше записей',
            cuerpo: 'Попробуй чуть позже или напиши нам в WhatsApp.',
        },
        no_confirmable_online: {
            titulo: 'Эту запись нельзя подтвердить онлайн',
            cuerpo: 'Напиши нам в WhatsApp, и мы всё решим.',
        },
        cerrado: {
            titulo: 'Онлайн-запись закрыта',
            cuerpo: 'Напиши нам в WhatsApp, и мы подберём время.',
        },
        servicio_no_disponible: {
            titulo: 'Эту услугу здесь записать нельзя',
            cuerpo: 'Выбери другую из списка или напиши нам в WhatsApp за советом.',
        },
        datos_invalidos: {
            titulo: 'Проверь свои данные',
            cuerpo: 'Что-то не так с именем или номером телефона.',
        },
        rango_invalido: {
            titulo: 'Не удалось подтвердить запись',
            cuerpo: 'Это наша ошибка. Напиши нам в WhatsApp, и мы запишем тебя вручную.',
        },
        error_interno: {
            titulo: 'Не удалось подтвердить запись',
            cuerpo: 'Попробуй ещё раз через минуту. Если не получается — напиши нам в WhatsApp.',
        },
        sin_conexion: {
            titulo: 'Не удалось подключиться',
            cuerpo: 'Проверь соединение и попробуй снова.',
        },
        hueco_caducado: {
            titulo: 'Это время уже занято',
            cuerpo: 'Его успел занять кто-то другой. Вот что осталось свободным.',
        },
        no_encontrado: {
            titulo: 'Такой страницы нет',
            cuerpo: 'Возможно, ссылка скопирована неверно или больше не работает.',
        },
    },
};

const UK: Textos = {
    titulo: 'Записатися',
    cargando: 'Одну хвилинку…',
    volver: 'Назад',
    idioma: 'Мова',
    pasoServicio: 'Послуга',
    pasoVariante: 'Варіант',
    pasoDia: 'День',
    pasoHora: 'Час',
    pasoDatos: 'Твої дані',
    de: 'з',
    paso: 'Крок',

    elegirServicio: 'Що ти хочеш зробити?',
    otrasOpciones: 'Не твій випадок?',
    puertaAsesoramiento: 'Не знаю, що обрати — потрібна порада',
    puertaVariasPersonas: 'Нас двоє або більше',
    elegirVariante: 'Обери відповідний варіант',
    desde: 'від',
    precioEnSalon: 'уточнюється в салоні',
    minutos: 'хв',
    horas: 'год',
    opciones: 'варіантів',

    elegirDia: 'Який день тобі зручний?',
    elegirHora: 'О котрій годині?',
    sinDias: 'У найближчі місяці вільних місць немає. Напиши нам, і ми підберемо час.',
    sinHoras: 'На цей день вільних місць не залишилося. Спробуй інший.',
    otroDia: 'Обрати інший день',
    mesAnterior: 'Попередній місяць',
    mesSiguiente: 'Наступний місяць',
    inicialesDias: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'],

    tuNombre: 'Твоє імʼя',
    tuNombreAyuda: 'Щоб знати, кого чекаємо',
    tuTelefono: 'Твій телефон',
    tuTelefonoAyuda: 'Нагадаємо у WhatsApp за день до візиту',
    tuPais: 'Країна',
    nombreCorto: 'Напиши своє імʼя',
    telefonoProblema: {
        letras: 'Номер пишеться лише цифрами',
        corto:  'Перевір номер: здається, бракує цифри',
        largo:  'Перевір номер: у ньому зайві цифри',
    },
    confirmar: 'Підтвердити запис',
    confirmando: 'Підтверджуємо…',
    resumen: 'Твій запис',

    confirmadaTitulo: 'Твій запис у {salon} підтверджено',
    confirmadaSinSalon: 'Твій запис підтверджено',
    estilistaEtiqueta: 'Майстер',
    avisoRecordatorio: 'За 24 години до візиту надійде нагадування у WhatsApp.',

    noSeHaPodidoAbrir: {
        titulo: 'Не вдалося відкрити запис',
        cuerpo: 'Можливо, справа у зʼєднанні. Спробуй ще раз за хвилину.',
    },

    escribirWhatsApp: 'Написати нам у WhatsApp',
    reintentar: 'Спробувати ще раз',
    esperaMinutos: 'Спробуй знову за {min} хв.',
    esperaSegundos: 'Спробуй знову за {seg} сек.',

    motivos: {
        hueco_ocupado: {
            titulo: 'Цей час щойно зайняли',
            cuerpo: 'Хтось записався, поки ти обирала. Ось години, які ще вільні цього дня.',
        },
        fuera_de_horario: {
            titulo: 'Цей час більше недоступний',
            cuerpo: 'Розклад змінився, поки ти записувалася. Ось години, які залишилися вільними.',
        },
        bloqueado: {
            titulo: 'Цей день більше недоступний',
            cuerpo: 'Салон закрив цей час. Обери інший день, і ми покажемо вільні години.',
        },
        tope_citas: {
            titulo: 'У тебе вже два записи',
            cuerpo: 'Третій тут оформити не можна. Напиши нам у WhatsApp, і ми запишемо тебе самі.',
        },
        hueco_no_existe: {
            titulo: 'Цей час уже зайнятий',
            cuerpo: 'Обери інший із тих, що залишилися.',
        },
        demasiadas_peticiones: {
            titulo: 'Забагато спроб поспіль',
            cuerpo: 'Зачекай трохи і спробуй знову. Якщо терміново — напиши нам у WhatsApp.',
        },
        salon_saturado: {
            titulo: 'Зараз ми не можемо підтвердити більше записів',
            cuerpo: 'Спробуй трохи пізніше або напиши нам у WhatsApp.',
        },
        no_confirmable_online: {
            titulo: 'Цей запис не можна підтвердити онлайн',
            cuerpo: 'Напиши нам у WhatsApp, і ми все вирішимо.',
        },
        cerrado: {
            titulo: 'Онлайн-запис закрито',
            cuerpo: 'Напиши нам у WhatsApp, і ми підберемо час.',
        },
        servicio_no_disponible: {
            titulo: 'Цю послугу тут записати не можна',
            cuerpo: 'Обери іншу зі списку або напиши нам у WhatsApp по пораду.',
        },
        datos_invalidos: {
            titulo: 'Перевір свої дані',
            cuerpo: 'Щось не так з імʼям або номером телефону.',
        },
        rango_invalido: {
            titulo: 'Не вдалося підтвердити запис',
            cuerpo: 'Це наша помилка. Напиши нам у WhatsApp, і ми запишемо тебе вручну.',
        },
        error_interno: {
            titulo: 'Не вдалося підтвердити запис',
            cuerpo: 'Спробуй ще раз за хвилину. Якщо не виходить — напиши нам у WhatsApp.',
        },
        sin_conexion: {
            titulo: 'Не вдалося підключитися',
            cuerpo: 'Перевір зʼєднання і спробуй знову.',
        },
        hueco_caducado: {
            titulo: 'Цей час уже зайнятий',
            cuerpo: 'Його встиг зайняти хтось інший. Ось що лишилося вільним.',
        },
        no_encontrado: {
            titulo: 'Такої сторінки немає',
            cuerpo: 'Можливо, посилання скопійовано неправильно або воно більше не працює.',
        },
    },
};

/** Los cuatro, completos. Un idioma que falte se nota: el tipo es `Record`, no `Partial`. */
export const TEXTOS: Record<Idioma, Textos> = { es: ES, en: EN, ru: RU, uk: UK };

export function textos(lang: unknown): Textos {
    return TEXTOS[idiomaValido(lang)] ?? ES;
}

/** Sustituye `{clave}` por su valor. Sin plantillas ni librerías: son cuatro cadenas. */
export function rellenar(plantilla: string, valores: Record<string, string>): string {
    return plantilla.replace(/\{(\w+)\}/g, (todo, clave) =>
        Object.prototype.hasOwnProperty.call(valores, clave) ? valores[clave] : todo);
}

/**
 * Lo que la página sabe del salón. Sale entero de la primera llamada (`/catalogo`) y todos
 * sus campos pueden ser null: el nombre y la dirección los edita la dueña y pueden no estar,
 * y sin teléfono utilizable el servidor no fabrica enlaces rotos (regla 3).
 */
export type Salon = {
    nombre: string | null;
    direccion: string | null;
    whatsapp: string | null;
    puertas: { asesoramiento: string | null; variasPersonas: string | null };
};

export const SALON_VACIO: Salon = {
    nombre: null, direccion: null, whatsapp: null,
    puertas: { asesoramiento: null, variasPersonas: null },
};

/**
 * Lee el `salon` de la respuesta. Los enlaces se comprueban igual que los de un aviso: un
 * `href` es la única cosa de esta pantalla donde un valor cualquiera se vuelve una acción.
 */
export function leerSalon(bruto: unknown): Salon {
    const b = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
    const p = (b.puertas && typeof b.puertas === 'object' ? b.puertas : {}) as Record<string, unknown>;
    const wa = (v: unknown) => (typeof v === 'string' && v.startsWith('https://wa.me/') ? v : null);
    const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
        nombre: txt(b.nombre),
        direccion: txt(b.direccion),
        whatsapp: wa(b.whatsapp),
        puertas: { asesoramiento: wa(p.asesoramiento), variasPersonas: wa(p.varias_personas) },
    };
}

// ─── Leer una respuesta que dice que no ──────────────────────────────────────────────────

export type Fallo = {
    motivo: Motivo;
    /** Lo dice la RESPUESTA (`recargarHuecos`), no una copia de la política. */
    recargarHuecos: boolean;
    whatsapp: string | null;
    esperaSegundos: number | null;
    /**
     * ¿Este «no» lo ha dicho el SERVIDOR, o se lo ha inventado la pantalla porque no hubo
     * respuesta que leer? Es lo que decide si se puede usar el WhatsApp de respaldo — ver
     * `enlaceDelAviso`, que es donde está explicado.
     */
    deLaPantalla: boolean;
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
        // «De la pantalla» = este «no» NO ha pasado por la política de reserva-web.js. Son
        // dos casos: un cuerpo que no se puede leer (motivo desconocido o ausente) y el que
        // fabrica el puente del Next cuando Express no contesta, que se marca `origen`.
        deLaPantalla: !MOTIVOS_CONOCIDOS.has(crudo) || c.origen === 'puente',
        // `estado` se ignora a propósito: el 409 de un hueco ocupado y el 409 de un tope de
        // citas se pintan distinto, y lo que los separa es el motivo. Queda en la firma
        // porque quien llama lo tiene y porque un motivo ausente con estado 200 sería un
        // caso que hoy no existe pero que conviene poder distinguir mañana.
    };
}

/**
 * El fallo que no manda nadie: el `fetch` ni siquiera llegó a contestar (el móvil en el
 * ascensor, el wifi del salón). Se fabrica aquí para que el componente no tenga que escribir
 * a mano un motivo, que es como se cuelan los que no existen.
 */
export function falloSinConexion(): Fallo {
    return {
        motivo: 'sin_conexion', recargarHuecos: false, whatsapp: null,
        esperaSegundos: null, deLaPantalla: true,
    };
}

/**
 * Qué enlace de WhatsApp se pinta en un aviso — y sobre todo, CUÁNDO no se pinta ninguno.
 *
 * La política de quién tiene salida humana vive en `services/reserva-web.js` y viaja en la
 * respuesta: si el motivo la tiene, el cuerpo trae `whatsapp`; si no, no lo trae. Aquí se
 * OBEDECE eso al pie de la letra, porque replicar la tabla sería tener dos.
 *
 * El respaldo —el enlace que la página guardó al cargar el catálogo— solo entra cuando NO HAY
 * respuesta que obedecer: la red caída, un cuerpo que no se puede leer, un motivo que este
 * código no conoce. Usarlo también con los «no» del servidor rompería la política por arriba:
 * un «ese hueco se acaba de ocupar» saldría con un botón de WhatsApp, cuando lo que esa
 * clienta tiene que hacer es tocar otra hora, que la tiene delante.
 */
export function enlaceDelAviso(fallo: Fallo, respaldo: string | null): string | null {
    if (fallo.whatsapp) return fallo.whatsapp;
    return fallo.deLaPantalla ? respaldo : null;
}

/**
 * Qué título y qué cuerpo lleva un aviso.
 *
 * Casi siempre es el de su motivo. La excepción es al ABRIR la página: ahí no se está
 * confirmando nada, así que «no hemos podido confirmar la cita» sería falso — y encima
 * remite a un WhatsApp que no se ha llegado a cargar, porque el enlace venía justo en la
 * respuesta que ha fallado. Los motivos con contenido propio (el enlace apagado, la página
 * que no existe) se dicen igual en los dos sitios.
 */
export function textoDelAviso(
    t: Textos, fallo: Fallo, opciones: { enCarga?: boolean } = {},
): { titulo: string; cuerpo: string } {
    if (opciones.enCarga && (fallo.motivo === 'error_interno' || fallo.motivo === 'sin_conexion')) {
        return t.noSeHaPodidoAbrir;
    }
    const base = t.motivos[fallo.motivo] ?? t.motivos.error_interno;
    return { titulo: base.titulo, cuerpo: base.cuerpo };
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
    categoria: string;
    nombre: string;
    /**
     * EL nombre del servicio: el que el servidor escribirá en `appointments.service` y el
     * que dirá el recordatorio. Llega hecho de `buildFullServiceName` — la pantalla NO lo
     * compone, y componerlo aquí fue el bug: «Cortes · Mujer y secado» en el resumen contra
     * «Corte mujer y secado» en la pantalla final, dos nombres para lo mismo y uno de ellos
     * inexistente en todo el sistema. Ver `nombreDeEntrada`.
     */
    nombreCompleto: string;
    precio: number | null;  // null = «se confirma en el salón». NUNCA se pinta como 0 €.
    duracion: number | null;
    /**
     * La línea de debajo del nombre: qué es esto, en el idioma de la pantalla. Es el único
     * campo del catálogo que llega TRADUCIDO, y lo rellena la dueña: null en las entradas
     * donde no ha escrito nada, que hoy son 61 de 82. Ver `explicacionPublica` en
     * `services/reserva-web.js` para por qué el NOMBRE no se traduce y esto sí.
     */
    explicacion: string | null;
};

export type GrupoServicio = {
    categoria: string;
    /**
     * Lo que se lee en la fila del paso 1. Con VARIAS entradas es la categoría, que ahí es
     * un rótulo de navegación y no el nombre de nada. Con UNA sola, la fila ES el servicio y
     * pone su nombre completo: «Brillo Glow» era la categoría, y la clienta acababa viendo
     * «Brillo intensivo» en la confirmación sin saber que era lo mismo. Cuatro de los seis
     * grupos de una entrada tenían esa divergencia.
     */
    titulo: string;
    entradas: EntradaCatalogo[];
    /** Precio más bajo del grupo, o null si NINGUNA entrada tiene precio. */
    desde: number | null;
    /** true cuando alguna entrada no tiene precio: entonces «desde» no cuenta la historia. */
    algunoSinPrecio: boolean;
    /**
     * La explicación del GRUPO: la que tienen TODAS sus entradas cuando escriben la misma.
     * null si difieren o si falta en alguna.
     *
     * No es un campo nuevo ni una tabla por categoría —que es la fragilidad que CLAUDE.md
     * ya tiene anotada dos veces—: sale de las entradas, y por eso la dueña decide cuál de
     * las dos cosas quiere con solo escribir.
     *
     *   · La MISMA frase en las cuatro entradas de «Mechas Balayage» → es del servicio, y
     *     sale una vez, arriba: qué es un balayage.
     *   · Una frase DISTINTA en cada una («hasta los hombros», «hasta la espalda»…) → es de
     *     la variante, y sale en su fila.
     *
     * Y con eso el mismo hueco vale para las dos cosas que pide el catálogo real: seis
     * categorías cuyas variantes son el LARGO, y nueve cuyas variantes son otra cosa
     * —cobertura en «Mechas clásicas», diez servicios distintos en «Manicura/Pedicura»—.
     */
    explicacion: string | null;
};

/**
 * El nombre de una entrada tal como llega del servidor, con su respaldo.
 *
 * Si `nombreCompleto` no viene —un Express viejo sin desplegar— se cae al `nombre` pelado,
 * que es un valor REAL del catálogo: sin categoría delante, pero de nadie inventado. Lo que
 * no se hace nunca es volver a pegar `categoria` y `nombre` con un separador (regla 3: si un
 * dato no se resuelve, no se fabrica uno que parezca bueno).
 */
export function nombreDeEntrada(bruto: Record<string, unknown>): string {
    const completo = typeof bruto.nombreCompleto === 'string' ? bruto.nombreCompleto.trim() : '';
    if (completo) return completo;
    return typeof bruto.nombre === 'string' ? bruto.nombre : '';
}

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

        const explicacion = typeof s.explicacion === 'string' && s.explicacion.trim()
            ? s.explicacion.trim() : null;

        let grupo = porCategoria.get(categoria);
        if (!grupo) {
            grupo = {
                categoria, titulo: categoria, entradas: [],
                desde: null, algunoSinPrecio: false, explicacion: null,
            };
            porCategoria.set(categoria, grupo);
        }
        grupo.entradas.push({
            key, categoria, nombre, nombreCompleto: nombreDeEntrada(s), precio, duracion, explicacion,
        });
        if (precio === null) grupo.algunoSinPrecio = true;
        else if (grupo.desde === null || precio < grupo.desde) grupo.desde = precio;
    }

    // El título se fija AL FINAL, cuando ya se sabe cuántas entradas tiene el grupo: con una
    // sola, la fila del paso 1 es el servicio y tiene que llamarse como se llamará después.
    const grupos = [...porCategoria.values()];
    for (const g of grupos) {
        g.titulo = g.entradas.length === 1 ? (g.entradas[0].nombreCompleto || g.categoria) : g.categoria;
        // La explicación del grupo: solo si TODAS coinciden. Con una sola entrada eso es
        // trivialmente la suya, que es lo que se quiere — ahí la fila ES el servicio.
        const primera = g.entradas[0]?.explicacion ?? null;
        g.explicacion = primera && g.entradas.every(e => e.explicacion === primera) ? primera : null;
    }

    return { grupos, descartadas };
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

// El locale de cada idioma. Es el mismo criterio que `REMINDER_DATE_LOCALE` en helpers.js,
// incluido el **en-GB** en vez de en-US: «25 August», no «August 25». Las dos fechas las lee
// la misma clienta.
const LOCALES: Record<Idioma, string> = { es: 'es-ES', en: 'en-GB', ru: 'ru-RU', uk: 'uk-UA' };

/**
 * «martes, 25 de agosto» — el rótulo de un día SUELTO, y por eso sale de `Intl` y no de una
 * tabla.
 *
 * ── Y AQUÍ ESTÁ LA RAYA, que es lo importante de esta función ────────────────────────────
 *
 * CLAUDE.md dice que el día de la semana se dice en UN solo sitio (`formatReminderWhen`), y
 * esto no lo incumple: son dos FORMAS distintas de la misma palabra.
 *
 *   · Detrás de una preposición el ruso y el ucraniano piden ACUSATIVO —«в среду»— y el
 *     martes cambia además la preposición («во вторник»). Eso `Intl` no lo sabe hacer, y por
 *     eso existe la tabla del servidor. Es la frase del recordatorio y de la confirmación, y
 *     llega HECHA desde allí (`cita.cuando`).
 *   · Un rótulo suelto encima de una rejilla de horas no lleva preposición: va en NOMINATIVO,
 *     que es exactamente lo que `Intl` devuelve. Copiar aquí la tabla del servidor pondría
 *     «в среду» de título, que en ruso se lee como una frase a medias.
 *
 * O sea: la tabla no se duplica porque lo que hace falta aquí no es lo que la tabla da.
 * Devuelve **null** si la fecha no se entiende, y quien llama enseña la fecha cruda.
 */
export function etiquetaDia(fecha: string, lang: unknown): string | null {
    const t = aUTC(fecha);
    if (!t) return null;
    return new Intl.DateTimeFormat(LOCALES[idiomaValido(lang)], {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    }).format(t);
}

/** «agosto de 2026», la cabecera de la rejilla. Mismo criterio: rótulo suelto, `Intl`. */
export function etiquetaMes(anio: number, mes: number, lang: unknown): string {
    return new Intl.DateTimeFormat(LOCALES[idiomaValido(lang)], {
        month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(Date.UTC(anio, mes, 15, 12, 0, 0)));
}

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

/**
 * Los meses que hay que poder hojear, deducidos de la RESPUESTA y no de un horizonte escrito
 * aquí. El servidor pide 90 días (`HORIZONTE_RESERVA_WEB`); copiar ese 90 en el navegador
 * sería una segunda constante que se queda vieja el día que Yulia cambie el horizonte, y el
 * síntoma sería un calendario con meses que no se pueden tocar. Con esto, la rejilla llega
 * exactamente hasta donde hay algo que reservar.
 *
 * Sin ningún día disponible se pinta el mes en curso, para que la clienta vea un calendario
 * vacío y no un hueco en la página.
 */
export function mesesConDisponibilidad(hoy: string, dias: DiaConHueco[]): Mes[] {
    const inicio = aUTC(hoy);
    if (!inicio) return [];
    let ultima = hoy;
    for (const d of dias || []) {
        if (d && typeof d.fecha === 'string' && FECHA_RE.test(d.fecha) && d.huecos > 0 && d.fecha > ultima) {
            ultima = d.fecha;
        }
    }
    const fin = aUTC(ultima);
    const horizonte = fin ? Math.max(0, Math.round((fin.getTime() - inicio.getTime()) / 86400000)) : 0;
    return construirMeses(hoy, horizonte, dias);
}

/** El índice del primer mes que tiene algún día elegible. -1 si no hay ninguno. */
export function primerMesConHueco(meses: Mes[]): number {
    return meses.findIndex(m => m.casillas.some(c => c.elegible));
}

// ─── El país del teléfono ────────────────────────────────────────────────────────────────
//
// El campo del teléfono era UNO, un número pelado, y el servidor le pegaba el `34` a todo lo
// que fueran nueve dígitos empezados por 6 o 7. Un móvil ucraniano escrito sin el 0 del
// tronco es exactamente eso, así que salía un móvil ESPAÑOL de otra persona. El porqué
// entero, con los números medidos contra producción, está en `services/reserva-web.js`.
//
// **La tabla no está aquí, y eso es la mitad del arreglo.** Vive en el servidor —que es
// quien compone el número que se guarda— y llega en la respuesta del catálogo, con la misma
// doctrina que la política de los motivos. Una lista de prefijos en el navegador y otra en
// Express es una pantalla que enseña un país y un servidor que compone otro.
//
// Aquí solo se pinta y se hace una comprobación floja para ahorrar el viaje.

export type Pais = {
    codigo: string;   // el prefijo internacional, sin '+' («34», «380»)
    iso: string;      // ISO-3166 alfa-2, SOLO para que el navegador ponga el nombre
    minimo: number;   // dígitos mínimos del número nacional, para el aviso sin viaje
};

/**
 * El respaldo cuando la respuesta no trae países: un Express viejo, o una respuesta a medias.
 *
 * Es España, y es deliberado: sin lista, lo que tiene que seguir funcionando es el camino
 * que hoy funciona —el 95 % de las fichas de Sante son `34`+9— y no una pantalla sin campo
 * de teléfono. No es un dato de la dueña (un prefijo telefónico no se edita desde el panel),
 * así que no le aplica la regla 5.
 */
export const PAIS_RESPALDO: Pais = { codigo: '34', iso: 'ES', minimo: 9 };

/** Lee la lista que mandó el servidor, desconfiando de cada campo. Una entrada a medias se
 *  DESCARTA en vez de pintarse con un prefijo vacío, que compondría el número sin país. */
export function leerPaises(bruto: unknown): Pais[] {
    const lista = Array.isArray(bruto) ? bruto : [];
    const out: Pais[] = [];
    for (const x of lista) {
        const p = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        const codigo = typeof p.codigo === 'string' ? p.codigo.trim() : '';
        const iso = typeof p.iso === 'string' ? p.iso.trim().toUpperCase() : '';
        if (!/^\d{1,4}$/.test(codigo) || !/^[A-Z]{2}$/.test(iso)) continue;
        const minimo = typeof p.minimo === 'number' && Number.isFinite(p.minimo) && p.minimo > 0
            ? Math.floor(p.minimo) : PAIS_RESPALDO.minimo;
        out.push({ codigo, iso, minimo });
    }
    return out.length ? out : [PAIS_RESPALDO];
}

/**
 * El NOMBRE del país, en el idioma de la pantalla, y lo pone el navegador.
 *
 * `Intl.DisplayNames` sabe decir ES → «España / Spain / Испания / Іспанія», así que no hay
 * que escribir 68 cadenas a mano ni mantenerlas: son datos del sistema, no texto nuestro, y
 * por eso NO están en la tabla de `TEXTOS`. Es la misma decisión que `etiquetaMes`.
 *
 * Si el navegador no lo sabe, sale el código ISO — `fallback: 'code'`, que es lo que hace
 * que un código sin datos salga como código y no desaparezca. Un país sin nombre es feo; un
 * país con el nombre equivocado manda un recordatorio a otro sitio (regla 3).
 *
 * Ojo con `'ZZ'` al probar esto: NO es un código sin datos, es el código CLDR de «región
 * desconocida» y devuelve esa frase traducida. Para el caso sin datos vale cualquier par de
 * letras sin asignar (`'QQ'`).
 */
export function nombrePais(iso: string, lang: unknown): string {
    try {
        const dn = new Intl.DisplayNames([LOCALES[idiomaValido(lang)]], {
            type: 'region', fallback: 'code',
        });
        return dn.of(iso) || iso;
    } catch { return iso; }
}

/** «+34». Una función para que la pantalla no vaya pegando el '+' en cuatro sitios. */
export function prefijoVisible(pais: Pais): string {
    return `+${pais.codigo}`;
}

/** El país elegido, o el primero de la lista. `undefined` NUNCA: el campo tiene que
 *  componerse contra algo, y la lista siempre trae al menos el respaldo. */
export function paisElegido(paises: Pais[], codigo: string | null): Pais {
    return paises.find(p => p.codigo === codigo) ?? paises[0] ?? PAIS_RESPALDO;
}

// ─── Lo que teclea la clienta ────────────────────────────────────────────────────────────

/**
 * El teléfono. Aquí NO se replica la composición —la forma canónica la decide el servidor,
 * que es quien escribe en `contacts`— y esto solo evita el viaje.
 *
 * **El mínimo sale del PAÍS elegido y el máximo no.** No es simetría rota, es lo que hace
 * que la pantalla no bloquee una reparación que el servidor sí sabe hacer: una ucraniana que
 * escribe «0 67 123 45 67» tiene un dígito de más para su país, y el servidor le quita el 0
 * del tronco y reserva. Si aquí se aplicara el máximo, ese número se pararía en la pantalla
 * con un «tiene dígitos de más» que es MENTIRA. El mínimo, en cambio, no lo puede reparar
 * nadie: faltan dígitos, y decírselo en el sitio es mejor que un viaje.
 *
 * Sin país (la carga inicial, antes de que llegue el catálogo) se usan los 9 de España, que
 * es lo que había antes de todo esto.
 *
 * Sigue fallando hacia el lado permisivo a propósito: si de verdad no vale, el servidor
 * devuelve `datos_invalidos` y la pantalla lo dice, con sus datos intactos.
 */
export function telefonoUsable(txt: unknown, pais?: Pais | null): boolean {
    const digitos = String(txt ?? '').replace(/\D/g, '');
    const minimo = pais && Number.isFinite(pais.minimo) ? pais.minimo : PAIS_RESPALDO.minimo;
    return digitos.length >= minimo && digitos.length <= 15;
}

export type ProblemaTelefono = 'letras' | 'corto' | 'largo';

/**
 * QUÉ le pasa a un teléfono que no vale. Solo elige el MENSAJE: el veredicto sigue siendo
 * `telefonoUsable`, y por eso lo primero que hace es preguntárselo.
 *
 * Esa separación es la decisión, y es lo contrario de lo que parece pedir el bug: con las
 * letras dentro del veredicto, «600 123 456 (casa)» dejaría de poder reservar, y hoy reserva
 * —el servidor lo sanea—. Nadie pierde una cita por esto; lo único que cambia es lo que lee
 * quien ya estaba parado.
 *
 * Los separadores que se perdonan son los que la gente teclea de verdad: espacios (también
 * el duro que meten algunos teclados), guiones, puntos, paréntesis, barras y el `+` del
 * prefijo. Lo que quede después de quitarlos y no sea un dígito ES una letra, y entonces
 * «parece que falta algún dígito» describe otro caso: el que lo dijo escribió su nombre,
 * un «móvil» al lado, o pegó texto.
 */
export function problemaTelefono(txt: unknown, pais?: Pais | null): ProblemaTelefono | null {
    if (telefonoUsable(txt, pais)) return null;
    const crudo = String(txt ?? '');
    const sinSeparadores = crudo.replace(/[\s\u00a0\-.()/+]/g, '');
    if (sinSeparadores && /\D/.test(sinSeparadores)) return 'letras';
    return crudo.replace(/\D/g, '').length > 15 ? 'largo' : 'corto';
}

export function nombreUsable(txt: unknown): boolean {
    return String(txt ?? '').trim().length >= 2;
}

// ─── Los pasos, el historial y el progreso ───────────────────────────────────────────────
//
// El bug: recargar o dar al ATRÁS del navegador a mitad del formulario devolvía al paso 1 con
// todo perdido y sin decir nada. En un móvil el atrás es lo primero que se toca para
// corregir, y quien va por el paso 4 y lo pierde todo no vuelve a empezar: se va.
//
// DÓNDE VIVE CADA MITAD, que es toda la decisión:
//
//   · el ATRÁS  → en la pila del HISTORIAL, una entrada por paso, SIEMPRE con la misma URL
//     (`pushState` sin tercer argumento). El paso NO va en la dirección, y eso es lo que
//     evita que un enlace copiado a mitad lleve la reserva de otra persona dentro — y que la
//     URL cuente por WhatsApp qué se iba a hacer.
//   · la RECARGA → en `sessionStorage`, que muere con la pestaña y no viaja a ningún sitio.
//
// Y lo que se recupera NO se cree: se vuelve a preguntar al motor. Un hueco elegido hace
// veinte minutos puede ser de otra desde hace diecinueve.

export type Paso = 'servicio' | 'variante' | 'dia' | 'hora' | 'datos' | 'hecha';

/** Los pasos del formulario, en orden. 'hecha' no está: es el final, no un paso. */
export const PASOS_FORMULARIO = ['servicio', 'variante', 'dia', 'hora', 'datos'] as const;
export type PasoFormulario = typeof PASOS_FORMULARIO[number];

const ES_PASO = new Set<string>([...PASOS_FORMULARIO, 'hecha']);

export type CitaHecha = {
    fecha: string;
    hora: string;
    cuando: string | null;
    servicio: string | null;
    estilista: string | null;
};

/**
 * La secuencia REAL de esta reserva. El paso de la variante solo existe cuando la categoría
 * tiene más de una: con una sola, elegir categoría ya elige servicio. De aquí salen a la vez
 * el «paso 3 de 4» de la cabecera y la profundidad de la pila del historial, y tienen que
 * ser la MISMA lista o el atrás y el contador contarían pasos distintos.
 */
export function secuenciaDe(grupo: { entradas: unknown[] } | null): PasoFormulario[] {
    return grupo && grupo.entradas.length > 1
        ? ['servicio', 'variante', 'dia', 'hora', 'datos']
        : ['servicio', 'dia', 'hora', 'datos'];
}

/** El paso que guarda una entrada del historial, o null si esa entrada no es nuestra. */
export function pasoDelHistorial(estado: unknown): Paso | null {
    if (!estado || typeof estado !== 'object') return null;
    const p = (estado as { reservaPaso?: unknown }).reservaPaso;
    return typeof p === 'string' && ES_PASO.has(p) ? (p as Paso) : null;
}

/**
 * Hasta dónde se puede llegar con lo que hay elegido AHORA MISMO.
 *
 * Lo necesita el botón de ADELANTE del navegador, que es el que nadie prueba: volver atrás
 * al día borra la hora, y darle entonces a adelante pedía el paso 'datos' con `hora` a null
 * — un paso que no se pinta, o sea la pantalla en blanco. Aquí se recorta al último paso que
 * de verdad tiene todo lo que necesita.
 */
export function pasoAlcanzable(
    destino: Paso,
    tengo: { grupo: { entradas: unknown[] } | null; entrada: unknown; fecha: string | null; hora: string | null },
): Paso {
    if (destino === 'hecha') return 'hecha';
    const seq = secuenciaDe(tengo.grupo);
    const puede = (p: PasoFormulario): boolean => {
        if (p === 'servicio') return true;
        if (p === 'variante') return !!tengo.grupo && tengo.grupo.entradas.length > 1;
        if (p === 'dia') return !!tengo.entrada;
        if (p === 'hora') return !!tengo.entrada && !!tengo.fecha;
        return !!tengo.entrada && !!tengo.fecha && !!tengo.hora;
    };
    const pedido = seq.indexOf(destino as PasoFormulario);
    if (pedido < 0) return 'servicio';
    for (let i = pedido; i > 0; i -= 1) if (puede(seq[i])) return seq[i];
    return 'servicio';
}

/**
 * Qué se OLVIDA al retroceder a un paso. Es lo mismo que hacía el botón «Atrás» de la
 * cabecera, sacado a una función porque ahora hay dos formas de retroceder —el botón y el
 * del navegador— y con dos copias se separan: retroceder con una dejaría la hora puesta y
 * con la otra no, y eso no se ve leyendo.
 */
export function limpiarAlVolver(destino: Paso): {
    grupo: boolean; entrada: boolean; fecha: boolean; hora: boolean; listas: boolean;
} {
    if (destino === 'servicio') return { grupo: true, entrada: true, fecha: true, hora: true, listas: true };
    if (destino === 'variante') return { grupo: false, entrada: true, fecha: true, hora: true, listas: true };
    if (destino === 'dia') return { grupo: false, entrada: false, fecha: false, hora: true, listas: false };
    return { grupo: false, entrada: false, fecha: false, hora: false, listas: false };
}

// ─── El progreso guardado ────────────────────────────────────────────────────────────────

export const VERSION_PROGRESO = 1;
/**
 * Doce horas. `sessionStorage` ya muere al cerrar la pestaña, así que esto no es para
 * limpiar: es porque ahí dentro hay un nombre y un teléfono, y una pestaña olvidada en un
 * móvil compartido no tiene por qué seguir teniéndolos mañana.
 */
export const VIDA_PROGRESO_MS = 12 * 60 * 60 * 1000;

export function claveProgreso(slug: string): string {
    return `reserva-web:${slug}`;
}

export type Progreso =
    | { paso: 'hecha'; cita: CitaHecha }
    | {
        paso: PasoFormulario;
        servicio: string;          // la clave `categoria|nombre`
        fecha: string | null;
        hora: string | null;
        nombre: string;
        /**
         * El PAÍS y el NÚMERO, separados igual que en la pantalla. Guardar el compuesto
         * obligaría a descomponerlo al volver, y descomponer un teléfono es adivinar — que
         * es justo lo que este cambio quita de en medio.
         */
        prefijo: string;
        telefono: string;
    };

export function serializarProgreso(p: Progreso, ahora: number): string {
    return JSON.stringify({ v: VERSION_PROGRESO, ts: ahora, ...p });
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Lee lo guardado, y lo lee DESCONFIANDO. Devuelve null —empezar limpio— ante cualquier cosa
 * que no sea exactamente lo que escribimos: otra versión del formato, un JSON roto, algo
 * caducado. Nada de esto es un error que haya que contarle a nadie: es una pestaña vieja.
 *
 * Lo que sí hace, y es la parte que importa, es DEGRADAR el paso en vez de tirarlo todo:
 * si la fecha guardada ya pasó, se pierden la fecha y la hora pero se conserva el servicio,
 * el nombre y el teléfono, y se vuelve al calendario. Perder cuatro pasos por uno malo es el
 * bug que estamos arreglando.
 */
export function leerProgreso(bruto: unknown, opciones: { hoy: string; ahora: number }): Progreso | null {
    if (typeof bruto !== 'string' || !bruto) return null;
    let obj: Record<string, unknown>;
    try {
        const x = JSON.parse(bruto);
        if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
        obj = x as Record<string, unknown>;
    } catch { return null; }

    if (obj.v !== VERSION_PROGRESO) return null;
    const ts = typeof obj.ts === 'number' && Number.isFinite(obj.ts) ? obj.ts : null;
    if (ts === null || opciones.ahora - ts > VIDA_PROGRESO_MS) return null;

    if (obj.paso === 'hecha') {
        const c = (obj.cita && typeof obj.cita === 'object' ? obj.cita : {}) as Record<string, unknown>;
        if (typeof c.fecha !== 'string' || typeof c.hora !== 'string') return null;
        return {
            paso: 'hecha',
            cita: {
                fecha: c.fecha,
                hora: c.hora,
                cuando: typeof c.cuando === 'string' ? c.cuando : null,
                servicio: typeof c.servicio === 'string' ? c.servicio : null,
                estilista: typeof c.estilista === 'string' ? c.estilista : null,
            },
        };
    }

    if (typeof obj.paso !== 'string' || !(PASOS_FORMULARIO as readonly string[]).includes(obj.paso)) return null;
    const servicio = typeof obj.servicio === 'string' ? obj.servicio : '';
    if (!servicio) return null;      // sin servicio no hay nada que recuperar: es el paso 1

    let fecha = typeof obj.fecha === 'string' && RE_FECHA.test(obj.fecha) ? obj.fecha : null;
    let hora = typeof obj.hora === 'string' && RE_HORA.test(obj.hora) ? obj.hora : null;
    // Una fecha que ya pasó no se propone: el motor tampoco la devolvería, y la pantalla
    // enseñaría una lista vacía sin explicar por qué.
    if (fecha && opciones.hoy && fecha < opciones.hoy) { fecha = null; hora = null; }
    if (!fecha) hora = null;

    let paso = obj.paso as PasoFormulario;
    if ((paso === 'hora' || paso === 'datos') && !fecha) paso = 'dia';
    if (paso === 'datos' && !hora) paso = 'hora';

    return {
        paso, servicio, fecha, hora,
        nombre: typeof obj.nombre === 'string' ? obj.nombre : '',
        // Sin `prefijo` guardado se queda vacío y la pantalla usa el primero de la lista.
        // Es lo que pasa con lo guardado ANTES de que existiera el selector, y por eso
        // `VERSION_PROGRESO` no sube: un campo nuevo que cae a un valor bueno no obliga a
        // tirar el progreso de quien esté a medias en el momento del despliegue. Y lo que
        // guardó con el campo único —un «+380…» tecleado entero— sigue funcionando: el '+'
        // manda sobre el desplegable (ver `componerTelefono`).
        prefijo: typeof obj.prefijo === 'string' ? obj.prefijo : '',
        telefono: typeof obj.telefono === 'string' ? obj.telefono : '',
    };
}

export type PlanRestauracion = {
    paso: Paso;
    grupo: GrupoServicio | null;
    entrada: EntradaCatalogo | null;
    fecha: string | null;
    hora: string | null;
    nombre: string;
    prefijo: string;
    telefono: string;
    cita: CitaHecha | null;
    /**
     * Qué hay que RELEER antes de fiarse de lo de arriba. Nunca es null cuando hay fecha:
     * lo guardado dice lo que ella eligió, no lo que sigue libre.
     */
    verificar: 'dias' | 'huecos' | null;
};

/**
 * De lo guardado a lo que la pantalla tiene que hacer.
 *
 * El servicio se resuelve contra el catálogo QUE ACABA DE LLEGAR, no contra el de antes: si
 * la dueña lo ha dado de baja entremedias, la clave ya no casa y se vuelve al paso 1 —con el
 * nombre y el teléfono puestos, que ésos no caducan—.
 */
export function restaurar(
    progreso: Progreso | null,
    catalogo: { grupos: GrupoServicio[] },
): PlanRestauracion | null {
    if (!progreso) return null;

    const vacio = {
        grupo: null, entrada: null, fecha: null, hora: null,
        nombre: '', prefijo: '', telefono: '', cita: null, verificar: null,
    } as const;

    if (progreso.paso === 'hecha') return { ...vacio, paso: 'hecha', cita: progreso.cita };

    const grupo = catalogo.grupos.find(g => g.entradas.some(e => e.key === progreso.servicio)) ?? null;
    const entrada = grupo?.entradas.find(e => e.key === progreso.servicio) ?? null;
    const datos = {
        nombre: progreso.nombre, prefijo: progreso.prefijo, telefono: progreso.telefono,
    };

    if (!grupo || !entrada) return { ...vacio, ...datos, paso: 'servicio' };

    // El paso de la variante puede haber DEJADO de existir: la dueña dio de baja las otras
    // opciones de esa categoría y ahora queda una. Sin esto, la pantalla pediría elegir entre
    // una sola cosa.
    let paso: PasoFormulario = progreso.paso;
    if (paso === 'variante' && grupo.entradas.length === 1) paso = 'dia';

    return {
        ...datos,
        paso, grupo, entrada,
        fecha: progreso.fecha,
        hora: progreso.hora,
        cita: null,
        verificar: progreso.fecha ? 'huecos' : (paso === 'servicio' || paso === 'variante' ? null : 'dias'),
    };
}

/**
 * El veredicto sobre el hueco recuperado, con la lista que ACABA de dar el motor.
 *
 * `leida` separa «ese día está vacío» de «no he podido preguntar», que es el hecho 2 de
 * CLAUDE.md metido en una pantalla: si la petición de huecos falló, aquí no se dice que la
 * hora se haya ocupado —eso sería inventarse un motivo— y se la deja donde estaba con el
 * aviso de red que ya puso quien hizo la llamada.
 */
export function trasVerificarHuecos(
    pedido: { paso: PasoFormulario; hora: string | null },
    huecos: { leida: boolean; horas: string[] },
): { paso: PasoFormulario; hora: string | null; aviso: Motivo | null } {
    if (!huecos.leida) return { paso: pedido.paso, hora: pedido.hora, aviso: null };
    if (!huecos.horas.length) return { paso: 'dia', hora: null, aviso: 'hueco_caducado' };
    if (pedido.hora && !huecos.horas.includes(pedido.hora)) {
        return { paso: 'hora', hora: null, aviso: 'hueco_caducado' };
    }
    return { paso: pedido.paso, hora: pedido.hora, aviso: null };
}

/**
 * Un aviso que pone la pantalla con una respuesta del servidor DELANTE — hoy solo el hueco
 * que ya no está, que se sabe porque el motor acaba de mandar la lista del día sin él.
 *
 * `deLaPantalla: false` no es un descuido: ese campo decide si se pinta el WhatsApp de
 * respaldo, y el respaldo es para cuando NO HUBO respuesta que obedecer. Aquí la hubo. Poner
 * true sacaría un botón de WhatsApp debajo de «esa hora ya no está libre», que es justo el
 * caso que `enlaceDelAviso` explica que no debe salir: lo que hay que hacer es tocar otra
 * hora, que la tiene delante.
 */
export function avisoPropio(motivo: Motivo): Fallo {
    return { motivo, recargarHuecos: false, whatsapp: null, esperaSegundos: null, deLaPantalla: false };
}
