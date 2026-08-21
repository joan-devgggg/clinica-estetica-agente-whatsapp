/**
 * reserva-web.js — La política del enlace público de reserva.
 *
 * Todo lo que decide QUÉ se deja hacer y QUÉ se deja ver desde fuera, en un solo sitio y sin
 * tocar la base de datos: los motivos, el limitador de peticiones, los topes que edita la
 * dueña y —lo más importante— las PROYECCIONES, que son las que deciden qué campos salen a
 * internet.
 *
 * Es la primera superficie del proyecto SIN SESIÓN. Hasta hoy todo lo que no era el webhook
 * de 360dialog colgaba de un JWT, así que ningún error de este fichero tenía dónde hacer
 * daño. Ahora sí.
 *
 * ── Los tres anillos, y dónde vive cada uno ──────────────────────────────────────────────
 *
 *   1. El SECRETO compartido Next→Express (webhook.js). Sin él no se entra: los endpoints
 *      están en internet aunque el navegador no los conozca.
 *   2. El LIMITADOR por IP y por org — aquí, en RAM del proceso de Express.
 *   3. El TOPE DE CITAS FUTURAS por contacto — en SQL, dentro de `reservar_hueco()`.
 *
 * **Por qué el 2 no puede vivir en el Next.** El panel corre en Vercel, que es serverless:
 * cada invocación puede caer en una instancia nueva y no hay memoria compartida entre ellas.
 * Un contador en RAM allí no cuenta nada — daría una sensación de protección que no existe,
 * que es peor que no tener ninguna. Express en Railway es UN proceso largo (el mismo que
 * sostiene `authCache`, el dedupe de mensajes y `alertOnce`), así que ahí el contador es
 * real.
 *
 * **Y por qué el 3 no puede vivir aquí.** Un contador en RAM se va con cada deploy o
 * reinicio, y en este repo eso pasa a menudo: medido sobre el reflog de `origin/main`, el
 * hueco MAYOR entre dos despliegues en 30 días fue de 1,88 días. Para una ventana de una
 * hora eso es aceptable y se dice; para «cuántas citas tienes ya reservadas» no lo es —
 * ese dato tiene que sobrevivir al deploy, y por eso lo cuenta Postgres.
 */

const { BUSINESS_TZ } = require('./date-utils');

// ─── Los motivos, conjunto CERRADO ───────────────────────────────────────────────────────
//
// Misma doctrina que MOTIVOS_OFRECIBLES y que el `motivo` de `reservar_hueco()`: un
// conjunto cerrado y una tabla que dice qué hacer con cada uno. Un motivo suelto en prosa
// obliga a la página a adivinar, y adivinar en la pantalla de confirmación de una reserva es
// como se pierde una clienta.
//
// Los cinco primeros los devuelve `reservar_hueco()` TAL CUAL — se declaran aquí para que la
// tabla de abajo sea exhaustiva y para que un motivo nuevo en la migración salga en rojo en
// vez de caer en un default.
const MOTIVOS = {
    OK: 'ok',
    // ── vienen de la función SQL ──
    HUECO_OCUPADO: 'hueco_ocupado',
    FUERA_DE_HORARIO: 'fuera_de_horario',
    BLOQUEADO: 'bloqueado',
    TOPE_CITAS: 'tope_citas',
    RANGO_INVALIDO: 'rango_invalido',
    // ── los pone esta capa ──
    DEMASIADAS_PETICIONES: 'demasiadas_peticiones',
    SALON_SATURADO: 'salon_saturado',
    NO_CONFIRMABLE_ONLINE: 'no_confirmable_online',
    DATOS_INVALIDOS: 'datos_invalidos',
    SERVICIO_NO_DISPONIBLE: 'servicio_no_disponible',
    HUECO_NO_EXISTE: 'hueco_no_existe',
    CERRADO: 'cerrado',
    ERROR_INTERNO: 'error_interno',
};

/**
 * Qué hacer con cada motivo. Tres decisiones por fila, y ninguna es cosmética:
 *
 *   · `estado`    — el código HTTP. 409 para «no se puede AHORA» (la página recarga), 429
 *                   para el limitador, 400 para lo que la clienta puede corregir.
 *   · `recargar`  — ¿la página tiene que volver a pedir los huecos? Solo cuando lo que ha
 *                   cambiado es la AGENDA. Recargar por un tope de citas sería enseñarle
 *                   otra vez lo mismo que acaba de no poder reservar.
 *   · `whatsapp`  — ¿se le abre la puerta a una persona? Va en TODO lo que la clienta no
 *                   puede resolver sola dándole a otro hueco. Es la decisión del punto 2 del
 *                   encargo: un tope de citas NO es un error, y una clienta que reserva para
 *                   ella y para su hija desde el mismo móvil es lo más normal del mundo.
 */
const POLITICA = {
    [MOTIVOS.HUECO_OCUPADO]:         { estado: 409, recargar: true,  whatsapp: false },
    [MOTIVOS.FUERA_DE_HORARIO]:      { estado: 409, recargar: true,  whatsapp: false },
    [MOTIVOS.BLOQUEADO]:             { estado: 409, recargar: true,  whatsapp: false },
    [MOTIVOS.HUECO_NO_EXISTE]:       { estado: 409, recargar: true,  whatsapp: false },
    // El tope: no es un fallo, es un límite. 409 y NO recargar — con WhatsApp, porque la
    // salida buena es hablar con el salón, no darle a otro hueco.
    [MOTIVOS.TOPE_CITAS]:            { estado: 409, recargar: false, whatsapp: true },
    [MOTIVOS.DEMASIADAS_PETICIONES]: { estado: 429, recargar: false, whatsapp: true },
    [MOTIVOS.SALON_SATURADO]:        { estado: 429, recargar: false, whatsapp: true },
    // Lista negra. Neutro por fuera y a propósito: en el salón bloquear es SILENCIO, pero
    // una página tiene que renderizar algo, y ese algo no puede ser «estás bloqueada».
    // Comparte texto y forma con el resto de «esto no se cierra online».
    [MOTIVOS.NO_CONFIRMABLE_ONLINE]: { estado: 409, recargar: false, whatsapp: true },
    [MOTIVOS.CERRADO]:               { estado: 503, recargar: false, whatsapp: true },
    [MOTIVOS.SERVICIO_NO_DISPONIBLE]:{ estado: 409, recargar: false, whatsapp: true },
    [MOTIVOS.DATOS_INVALIDOS]:       { estado: 400, recargar: false, whatsapp: false },
    // `rango_invalido` significa que NUESTRO javascript construyó mal el rango: no es culpa
    // de la clienta y no se le puede pedir que lo arregle. Sale como error interno.
    [MOTIVOS.RANGO_INVALIDO]:        { estado: 500, recargar: false, whatsapp: true },
    [MOTIVOS.ERROR_INTERNO]:         { estado: 500, recargar: false, whatsapp: true },
};

// Los motivos que la función SQL puede devolver. Si la migración creciera con uno nuevo y
// aquí no estuviera, `interpretarMotivoSql` lo convierte en error_interno con traza en vez
// de dejarlo pasar como si fuera conocido (regla 3: si no se resuelve, no se inventa).
const MOTIVOS_SQL = new Set([
    MOTIVOS.OK, MOTIVOS.HUECO_OCUPADO, MOTIVOS.FUERA_DE_HORARIO,
    MOTIVOS.BLOQUEADO, MOTIVOS.TOPE_CITAS, MOTIVOS.RANGO_INVALIDO,
]);

function interpretarMotivoSql(motivo) {
    return MOTIVOS_SQL.has(motivo) ? motivo : MOTIVOS.ERROR_INTERNO;
}

// ─── El mensaje que se le escribe a WhatsApp ─────────────────────────────────────────────
//
// Cuatro idiomas desde el día uno, como `formatSlotTexto` y `formatReminderWhen`: una
// clienta rusa contra un formulario en castellano es el fallo de Nora otra vez, y aquí sale
// barato evitarlo.
//
// La frase la escribe la MÁQUINA y no el modelo (aquí no hay modelo), así que es una tabla.
// Un idioma desconocido cae a castellano, mismo criterio que el resto del sistema.
const TEXTO_WHATSAPP = {
    [MOTIVOS.TOPE_CITAS]: {
        es: 'Hola, quiero reservar otra cita y la web no me deja porque ya tengo dos.',
        en: 'Hi, I would like to book another appointment — the website says I already have two.',
        ru: 'Здравствуйте, хочу записаться ещё раз, но сайт не даёт: у меня уже две записи.',
        uk: 'Доброго дня, хочу записатися ще раз, але сайт не дозволяє: у мене вже два записи.',
    },
    [MOTIVOS.NO_CONFIRMABLE_ONLINE]: {
        es: 'Hola, quiero pedir cita y la web no me la confirma.',
        en: 'Hi, I would like to book an appointment — the website will not confirm it.',
        ru: 'Здравствуйте, хочу записаться, но сайт не подтверждает запись.',
        uk: 'Доброго дня, хочу записатися, але сайт не підтверджує запис.',
    },
    // ── LAS DOS PUERTAS ─────────────────────────────────────────────────────────────────
    //
    // No son motivos: no las devuelve nadie que diga que no. Son las dos salidas VOLUNTARIAS
    // que la clienta puede tomar desde el primer paso, y viven en esta tabla porque son las
    // mismas cuatro traducciones y con dos tablas se separarían.
    //
    // Las dos existen porque el formulario NO SABE hacer eso, y el brief ya lo dejó escrito:
    //
    //   · «no lo tengo claro» → la Consulta de valoración es `reactive-only` desde el
    //     02/08/2026 y el bot tiene PROHIBIDO ofrecerla; un desplegable público que la
    //     ponga es justo lo que esa regla prohíbe. Así que se pasa el turno a una persona.
    //   · «somos dos o más» → el motor NI SIQUIERA PUEDE VER si hay dos estilistas libres a
    //     la misma hora (el dedupe por fecha-hora las colapsa), y `saveAppointment` funde
    //     dos citas del mismo contacto a la misma hora devolviendo la primera como si fuera
    //     nueva. Sin esta puerta, esa clienta acaba con UNA cita creyendo que tiene dos.
    //
    // Son baratas y cazan justo los dos casos que, si no, terminan en una reserva mal hecha.
    asesoramiento: {
        es: 'Hola, no tengo claro qué servicio necesito y me gustaría que me asesoréis.',
        en: 'Hi, I am not sure which service I need — could you advise me?',
        ru: 'Здравствуйте, я не знаю, какая услуга мне нужна. Подскажете?',
        uk: 'Доброго дня, я не знаю, яка послуга мені потрібна. Підкажете?',
    },
    varias_personas: {
        es: 'Hola, queremos pedir cita para dos personas o más.',
        en: 'Hi, we would like to book for two people or more.',
        ru: 'Здравствуйте, хотим записаться вдвоём или больше.',
        uk: 'Доброго дня, хочемо записатися вдвох або більше.',
    },
    // El resto —limitador, cerrado, servicio que ya no se ofrece, avería— comparten frase:
    // desde fuera son la misma situación («no he podido, ayúdame») y multiplicar frases
    // multiplica traducciones que nadie revisa.
    generico: {
        es: 'Hola, quiero pedir cita y no he podido hacerlo desde la web.',
        en: 'Hi, I would like to book an appointment but could not do it on the website.',
        ru: 'Здравствуйте, хочу записаться, но не получилось через сайт.',
        uk: 'Доброго дня, хочу записатися, але не вдалося через сайт.',
    },
};

// Las puertas, conjunto CERRADO como los motivos. Se enumeran para que `salonPublico` no
// pueda fabricar un enlace con una clave que no existe (caería en el texto genérico y la
// clienta escribiría «no he podido hacerlo desde la web» sin haberlo intentado).
const PUERTAS = ['asesoramiento', 'varias_personas'];

const IDIOMAS = ['es', 'en', 'ru', 'uk'];
const idiomaValido = lang => (IDIOMAS.includes(lang) ? lang : 'es');

/**
 * El enlace de WhatsApp con el mensaje ya escrito. `waPhone` sale del REGISTRY (es un dato
 * del sistema, no algo que la dueña edite desde el panel), así que no puede quedarse vacío
 * por una config a medias.
 */
function enlaceWhatsApp(waPhone, motivo, lang) {
    const digits = String(waPhone || '').replace(/\D/g, '');
    if (!digits) return null;   // regla 3: sin número no se fabrica un enlace roto
    const tabla = TEXTO_WHATSAPP[motivo] || TEXTO_WHATSAPP.generico;
    const texto = tabla[idiomaValido(lang)] || tabla.es;
    return `https://wa.me/${digits}?text=${encodeURIComponent(texto)}`;
}

/**
 * La respuesta de un NO, entera. Un solo constructor para que ninguna rama se invente su
 * propia forma: la página lee siempre los mismos cuatro campos.
 */
function respuestaNo(motivo, { waPhone, lang, esperaSegundos } = {}) {
    const pol = POLITICA[motivo] || POLITICA[MOTIVOS.ERROR_INTERNO];
    const cuerpo = { ok: false, motivo, recargarHuecos: pol.recargar };
    if (pol.whatsapp) {
        const url = enlaceWhatsApp(waPhone, motivo, lang);
        if (url) cuerpo.whatsapp = url;
    }
    if (Number.isFinite(esperaSegundos)) cuerpo.esperaSegundos = esperaSegundos;
    return { estado: pol.estado, cuerpo };
}

// ─── Los topes, que los edita la dueña ───────────────────────────────────────────────────
//
// Viven en `config` (clave-valor por org) y NO en constantes de este fichero: es la regla 5.
// Los defaults son los del plan del 19/08 y solo se usan cuando la clave no existe todavía.
//
// LA LECTURA es lo único delicado: `config` guarda TEXTO, así que un '3' llega como cadena.
// Un `Number(v) || DEFAULT` colaría un 0 como «usa el default», y un 0 es justo lo que
// alguien escribiría para CERRAR el grifo. Por eso se valida explícitamente y un valor
// ilegible cae al default DICIÉNDOLO, nunca en silencio.
const LIMITES_DEFAULT = {
    reservas_web_activo: false,          // nace APAGADO: se enciende cuando la dueña lo diga
    reservas_web_max_hora_ip: 3,         // reservas por hora y por IP
    reservas_web_max_hora_org: 10,       // techo global del salón por hora
    reservas_web_max_futuras: 2,         // citas web futuras por contacto (lo aplica el SQL)
    // Las LECTURAS necesitan su propio tope, y muy por encima del de escritura: pintar un
    // mes y abrir varios días son decenas de peticiones de una clienta normal. Con el 3/h de
    // las reservas, la página se rompería sola en el primer minuto de uso.
    reservas_web_max_hora_lecturas_ip: 120,
};

function leerEntero(valor, porDefecto, { min = 0, max = 100000 } = {}) {
    if (valor === undefined || valor === null || valor === '') return { valor: porDefecto, porDefecto: true };
    const n = Number(valor);
    if (!Number.isInteger(n) || n < min || n > max) return { valor: porDefecto, porDefecto: true, invalido: true };
    return { valor: n, porDefecto: false };
}

function leerBooleano(valor, porDefecto) {
    if (valor === undefined || valor === null || valor === '') return { valor: porDefecto, porDefecto: true };
    const v = String(valor).trim().toLowerCase();
    if (['true', '1', 'on', 'si', 'sí'].includes(v)) return { valor: true, porDefecto: false };
    if (['false', '0', 'off', 'no'].includes(v)) return { valor: false, porDefecto: false };
    return { valor: porDefecto, porDefecto: true, invalido: true };
}

/**
 * Resuelve los topes de una org a partir del mapa de `config`. Devuelve además `invalidas`,
 * la lista de claves que había que ignorar: quien llama la registra, porque un tope escrito
 * a mano y mal es exactamente lo que nadie se entera de que no está aplicándose.
 */
function resolverLimites(configMap = {}) {
    const invalidas = [];
    const out = {};
    const activo = leerBooleano(configMap.reservas_web_activo, LIMITES_DEFAULT.reservas_web_activo);
    if (activo.invalido) invalidas.push('reservas_web_activo');
    out.activo = activo.valor;

    for (const clave of ['reservas_web_max_hora_ip', 'reservas_web_max_hora_org',
                         'reservas_web_max_futuras', 'reservas_web_max_hora_lecturas_ip']) {
        const r = leerEntero(configMap[clave], LIMITES_DEFAULT[clave], { min: 0, max: 100000 });
        if (r.invalido) invalidas.push(clave);
        out[clave] = r.valor;
    }
    out.invalidas = invalidas;
    return out;
}

// ─── El limitador ────────────────────────────────────────────────────────────────────────

const HORA_MS = 60 * 60 * 1000;
// Tope de claves distintas que el limitador guarda a la vez. NO es una optimización: sin él,
// el propio limitador es el agujero — cada IP nueva crea una entrada, así que quien tenga
// muchas IPs llena la RAM del proceso que sostiene a las DOS organizaciones. Al llegar al
// tope se desalojan las más antiguas, que es el lado recuperable: se pierde memoria de un
// abusador viejo, nunca se deja de contar al que está pegando ahora.
const MAX_CLAVES = 20000;

/**
 * Ventana deslizante en RAM. `ahora` es inyectable para poder probar el paso del tiempo sin
 * dormir (los tests de este repo no duermen: es lo que hizo bajar la suite de 224 s a 60 s).
 *
 * `consumir` APUNTA el intento y decide a la vez. Separarlo en «mirar» y «apuntar» abre una
 * carrera entre las dos llamadas, y en un endpoint público esa carrera es el bypass.
 */
function crearLimitador({ ahora = () => Date.now(), maxClaves = MAX_CLAVES } = {}) {
    const golpes = new Map();   // clave → number[] (timestamps, orden creciente)

    function purgar(clave, desde) {
        const xs = golpes.get(clave);
        if (!xs) return [];
        // Los timestamps entran en orden, así que basta con tirar del principio.
        let i = 0;
        while (i < xs.length && xs[i] <= desde) i += 1;
        const vivos = i ? xs.slice(i) : xs;
        if (vivos.length) golpes.set(clave, vivos); else golpes.delete(clave);
        return vivos;
    }

    return {
        /**
         * @returns {{permitido: boolean, restantes: number, esperaSegundos: number}}
         *   `esperaSegundos` es cuánto falta para que se libere un hueco de la ventana. Se
         *   devuelve para poder decírselo a quien llama; no se promete en la respuesta
         *   pública salvo donde la política lo pida.
         */
        consumir(clave, { limite, ventanaMs = HORA_MS }) {
            const t = ahora();
            // Un límite de 0 es «cerrado», y es una decisión legítima de la dueña: se
            // respeta tal cual en vez de tratarlo como «sin configurar».
            if (!Number.isFinite(limite) || limite <= 0) {
                return { permitido: false, restantes: 0, esperaSegundos: Math.ceil(ventanaMs / 1000) };
            }
            const vivos = purgar(clave, t - ventanaMs);
            if (vivos.length >= limite) {
                const esperaMs = Math.max(0, vivos[0] + ventanaMs - t);
                return { permitido: false, restantes: 0, esperaSegundos: Math.ceil(esperaMs / 1000) };
            }
            if (!golpes.has(clave) && golpes.size >= maxClaves) {
                // Map conserva el orden de inserción: la primera es la más antigua.
                const masVieja = golpes.keys().next().value;
                golpes.delete(masVieja);
            }
            golpes.set(clave, [...vivos, t]);
            return { permitido: true, restantes: limite - vivos.length - 1, esperaSegundos: 0 };
        },
        // Solo para tests y para una traza de tamaño: nunca para decidir nada.
        _claves: () => golpes.size,
        /** Solo para tests: olvida todo lo contado (molde de `_resetThrottle`). Hace falta
         *  porque el limitador es UN singleton del proceso —que es justo lo que lo hace
         *  real— y sin esto un bloque de test hereda lo que gastó el anterior. */
        _reset: () => golpes.clear(),
    };
}

// ─── El candado del doble envío ──────────────────────────────────────────────────────────
//
// La pantalla ya tiene su cerrojo síncrono, y con eso basta para dos toques en el mismo
// móvil y la misma pestaña. Lo que no puede tapar desde el navegador es lo otro: dos
// pestañas, un «atrás» y volver a darle, o un reenvío del formulario cuando la conexión se
// cortó justo al confirmar. Esos llegan aquí como dos POST idénticos.
//
// **Y sin esto salen DOS citas, no una.** El claim de `reservar_hueco()` protege el HUECO,
// no la petición: la segunda pierde la carrera contra la estilista de la primera, pero el
// handler —cuando la clienta no eligió estilista— reintenta con la SIGUIENTE del hueco, que
// está libre. Resultado: la misma persona, a la misma hora, con dos estilistas. Y el tope de
// citas futuras no lo para, porque la primera solo suma una.
//
// LA CLAVE ES (org, teléfono, fecha, hora) Y NO LLEVA EL SERVICIO. Es a propósito: la misma
// persona no puede estar a la misma hora haciéndose dos cosas en sitios distintos, así que
// dos peticiones que coinciden en esos cuatro campos son la misma reserva, diga lo que diga
// el resto del cuerpo. Con el servicio dentro, cambiar de idea entre toque y toque abriría
// una clave nueva y volveríamos a tener dos citas.
//
// ── Lo que este candado NO es ────────────────────────────────────────────────────────────
//
// Vive en la RAM del proceso, así que se va con cada despliegue y no cubre dos instancias.
// Es aceptable aquí y no lo era para el tope de citas —que por eso lo cuenta Postgres—
// porque lo que se protege dura segundos, no días: un doble envío ocurre dentro de la misma
// sesión de una clienta. Lo que quedaría descubierto es un reenvío justo en el segundo del
// deploy, y para eso está el EXCLUDE de la 043 cuando coincide la estilista.
//
// SOLO SE GUARDA EL ÉXITO. Un «no» no se cachea: si el hueco estaba ocupado y ella vuelve a
// darle, tiene derecho a que se mire otra vez. Guardar los noes convertiría un fallo
// pasajero en un fallo pegajoso durante el TTL.

const CANDADO_TTL_MS = 90 * 1000;
// Mismo motivo que MAX_CLAVES del limitador: sin tope, el candado ES el agujero.
const CANDADO_MAX = 5000;

/**
 * @returns un objeto con `ejecutar(clave, trabajo)`, donde `trabajo` devuelve
 *   `{ estado, cuerpo, ok }`. La respuesta que se devuelve lleva además `repetida`.
 */
function crearCandadoReserva({ ahora = () => Date.now(), ttlMs = CANDADO_TTL_MS, maxClaves = CANDADO_MAX } = {}) {
    const enCurso = new Map();   // clave → Promise<{estado, cuerpo, ok}>
    const hechas = new Map();    // clave → { valor, expira }

    function podar(t) {
        for (const [k, v] of hechas) if (v.expira <= t) hechas.delete(k);
        while (hechas.size >= maxClaves) {
            const masVieja = hechas.keys().next().value;
            if (masVieja === undefined) break;
            hechas.delete(masVieja);
        }
    }

    return {
        async ejecutar(clave, trabajo) {
            const t = ahora();

            // (1) ¿Ya salió bien hace un momento? Se devuelve LA MISMA respuesta: la clienta
            // ve su tic verde otra vez, no una segunda cita ni un error incomprensible.
            const hecha = hechas.get(clave);
            if (hecha) {
                if (hecha.expira > t) return { ...hecha.valor, repetida: true };
                hechas.delete(clave);
            }

            // (2) ¿Hay una en vuelo? ESTA comprobación es síncrona respecto de sí misma —no
            // hay ningún `await` entre mirar el Map y escribirlo— y es lo que hace que dos
            // peticiones simultáneas no puedan pasar las dos.
            const vuelo = enCurso.get(clave);
            if (vuelo) return { ...(await vuelo), repetida: true };

            const promesa = (async () => trabajo())();
            enCurso.set(clave, promesa);
            try {
                const r = await promesa;
                if (r && r.ok) {
                    podar(ahora());
                    hechas.set(clave, { valor: r, expira: ahora() + ttlMs });
                }
                return { ...r, repetida: false };
            } finally {
                enCurso.delete(clave);
            }
        },
        _tamano: () => ({ enCurso: enCurso.size, hechas: hechas.size }),
        /** Solo para tests: es un singleton del proceso, como el limitador. */
        _reset: () => { enCurso.clear(); hechas.clear(); },
    };
}

/** La clave del candado. Una función para que el test afirme QUÉ entra y qué no. */
function claveDeReserva(orgId, telefono, fecha, hora) {
    return `${orgId}:${telefono}:${fecha}:${hora}`;
}

// ─── El teléfono: el país se ELIGE, jamás se adivina ─────────────────────────────────────
//
// Hasta el 22/08/2026 el formulario tenía UN campo de teléfono, un número pelado, y el
// servidor se lo daba a `sanitizePhone`. Esa función prefija `34` a todo lo que sean nueve
// dígitos que empiecen por 6 o por 7 — y eso es exactamente un móvil ucraniano escrito sin
// el 0 del tronco.
//
//     «67 123 45 67»  →  671234567  →  sanitizePhone  →  34671234567
//
// No es un número que no exista: es un móvil ESPAÑOL, de otra persona. `contacts` tiene
// UNIQUE (organization_id, wa_phone), así que si esa española ya es clienta, la cita web se
// cuelga de SU ficha, la lista negra se comprueba contra ELLA y el recordatorio de 24 h se
// lo lleva ELLA. Un ruso escrito sin prefijo («916 123 45 67», diez dígitos) falla más
// barato: no casa el patrón español, se guarda tal cual, y como no es de nadie Meta
// responde 200 y no entrega (hecho 3 de la cabecera).
//
// **No es hipotético, y está medido** (21/08/2026, contra producción): de las 771 fichas de
// Sante, 735 son `34`+9 y 36 no lo son. De esas 36, **cinco no son un teléfono**: dos
// empiezan por `0`, dos tienen menos de diez dígitos y una está vacía. Y eso SIN que el
// enlace haya escrito ni una sola (`source='web'` = 0 citas): entraron por el panel y por la
// importación. El enlace no iba a crear el problema, iba a abrirle un grifo — con nadie
// mirando, que es la diferencia.
//
// ── LO QUE NO SE TOCA, Y POR QUÉ ─────────────────────────────────────────────────────────
//
// **`sanitizePhone` se queda como está.** Es COMPARTIDA con San Remo (regla de oro) y con
// todo el pipeline de entrada de WhatsApp, donde su prefijado del `34` es correcto y
// necesario: ahí los nueve dígitos vienen del panel o de un JID y son españoles de verdad.
// Lo que cambia no es la función: es lo que se le da de comer. Después de componer aquí, lo
// que sale SIEMPRE lleva prefijo de país, así que `MOVIL_ES_SIN_PREFIJO` (que exige
// exactamente nueve dígitos) no puede casar nunca y `sanitizePhone` es un no-op — hay un
// test que lo afirma. La forma guardada sigue siendo la misma de siempre: E.164 sin `+`,
// solo dígitos, que es la que `contacts.wa_phone` y el bot ya usan.
//
// **Y no se reescribe nada de lo guardado.** Este cambio solo decide lo que el ENLACE compone
// de aquí en adelante; no hay migración ni backfill. Las cinco fichas malformadas siguen
// malformadas —arreglarlas es decidir a quién pertenece cada número, y eso lo decide una
// persona— y los duplicados anteriores a `sanitizePhone` los siguen cubriendo en LECTURA las
// variantes de `phoneVariants`.
//
// ── LA TABLA ─────────────────────────────────────────────────────────────────────────────
//
// Corta a propósito: son los países que Sante TIENE en su tabla de contactos, más los
// vecinos evidentes. No pretende ser el plan de numeración mundial, y no hace falta que lo
// sea — quien venga de fuera de la lista escribe su número con `+` delante y se le respeta
// tal cual (ver `componerTelefono`). Esa es la puerta de atrás, y es la que hace que una
// lista corta no deje a nadie fuera.
//
//   · `troncal` es el dígito que, si va DELANTE del número nacional, es el prefijo de salida
//     nacional y sobra. Es `'0'` en casi toda Europa; en Rusia y Kazajistán es `'8'`; y en
//     **Italia es `null` porque los fijos italianos CONSERVAN su 0** (+39 06… es Roma). Esa
//     es la excepción de libro, hay tres contactos italianos, y por eso está declarada aquí
//     y no descubierta el día que una llame.
//   · `nsn` es el largo del número nacional, y es lo que decide si una reparación se aplica:
//     el 0 del tronco solo se quita si quitarlo produce un largo VÁLIDO. **Ante la duda, el
//     rango va ANCHO**: uno demasiado ancho deja pasar un número malo —que es exactamente lo
//     que pasa hoy, donde no hay ninguna comprobación de largo en el servidor— y uno
//     demasiado estrecho deja a una clienta real sin poder reservar. Alemania e Italia son
//     anchos porque de verdad lo son.
//
// El ORDEN es el del desplegable, y no es alfabético: España primero porque es el 95 % y el
// valor por defecto, y detrás Ucrania y Rusia, que son las dos que trajeron este encargo. El
// resto va por código ISO. El NOMBRE del país no está aquí: lo pone el navegador con
// `Intl.DisplayNames` en el idioma de la pantalla, que es correcto en los cuatro y no son
// 68 cadenas que traducir a mano (ver `nombrePais` en nucleo.ts).
const PAISES = [
    { codigo: '34',  iso: 'ES', troncal: '0', nsn: [9, 9] },
    { codigo: '380', iso: 'UA', troncal: '0', nsn: [9, 9] },
    { codigo: '7',   iso: 'RU', troncal: '8', nsn: [10, 10] },
    { codigo: '32',  iso: 'BE', troncal: '0', nsn: [8, 9] },
    { codigo: '41',  iso: 'CH', troncal: '0', nsn: [9, 9] },
    { codigo: '49',  iso: 'DE', troncal: '0', nsn: [6, 11] },
    { codigo: '33',  iso: 'FR', troncal: '0', nsn: [9, 9] },
    { codigo: '44',  iso: 'GB', troncal: '0', nsn: [9, 10] },
    { codigo: '353', iso: 'IE', troncal: '0', nsn: [7, 9] },
    // Italia: SIN troncal. Sus fijos llevan el 0 dentro del número nacional.
    { codigo: '39',  iso: 'IT', troncal: null, nsn: [6, 11] },
    { codigo: '52',  iso: 'MX', troncal: '0', nsn: [10, 10] },
    { codigo: '31',  iso: 'NL', troncal: '0', nsn: [9, 9] },
    { codigo: '47',  iso: 'NO', troncal: '0', nsn: [8, 8] },
    { codigo: '48',  iso: 'PL', troncal: '0', nsn: [9, 9] },
    { codigo: '351', iso: 'PT', troncal: '0', nsn: [9, 9] },
    { codigo: '40',  iso: 'RO', troncal: '0', nsn: [9, 9] },
    // +1 es Estados Unidos Y Canadá. Se enseña con la bandera de uno de los dos porque
    // `Intl.DisplayNames` traduce PAÍSES y no zonas de numeración; el número que se compone
    // es idéntico para los dos, que es lo único que cambia una cita.
    { codigo: '1',   iso: 'US', troncal: null, nsn: [10, 10] },
];

const PAIS_POR_DEFECTO = '34';

/** Lo que de esta tabla necesita la pantalla, y ni un campo más.
 *
 *  `minimo` va porque la pantalla lo usa para decir «parece que falta algún dígito» sin
 *  viaje al servidor. NO viaja el máximo ni el troncal: la pantalla no compone nada —lo hace
 *  `componerTelefono`, aquí— y darle las piezas de la composición sería invitar a que un día
 *  las use y nazca la segunda versión de esta regla. */
function paisesPublicos() {
    return PAISES.map(p => ({ codigo: p.codigo, iso: p.iso, minimo: p.nsn[0] }));
}

const dentroDe = ([min, max], n) => n >= min && n <= max;

/**
 * De lo que ella teclea a la forma con la que trabaja el bot.
 *
 * Devuelve `{ ok:true, telefono }` con SOLO DÍGITOS y prefijo de país delante — lo que hay
 * que pasarle a `sanitizePhone` (para el que será un no-op) y de ahí a `contacts.wa_phone`.
 *
 * ── Las tres formas en las que la gente escribe su número, y qué se hace con cada una ────
 *
 *  1. **Con `+` o `00` delante** → es ella diciendo «esto ya lleva prefijo». Se respeta TAL
 *     CUAL, aunque no coincida con el país del desplegable: quien escribe el `+` sabe lo que
 *     hace, y ésta es la puerta por la que puede reservar alguien de un país que no está en
 *     la lista corta. Aquí no se repara nada — no hay país fiable contra el que comprobar.
 *  2. **El número nacional** → se le pone delante el código del país elegido.
 *  3. **Algo intermedio** (el código de país pegado, el 0 del tronco delante, o los dos) → se
 *     repara, y SOLO si la reparación produce un largo válido para ese país. Ése es el
 *     candado: sin él, «reparar» sería adivinar.
 *
 * ── LAS DOS PODAS, EN ESTE ORDEN Y CADA UNA CON SU CANDADO ──────────────────────────────
 *
 * **(a) El código del país, si ya está delante.** No es una corrección: se quita y se vuelve
 * a poner, así que por sí sola esta poda devuelve EXACTAMENTE lo que ella escribió. Es un
 * candado contra duplicar el prefijo, y por eso puede permitirse ser generosa. Su guarda es
 * que lo que quede tenga un largo nacional plausible — con un dígito de margen, que es el
 * hueco donde cabe un tronco pegado detrás («380 067 123 45 67», que existe).
 *
 * **(b) El dígito de salida nacional.** Ésta SÍ transforma, y por eso el que lo declara es
 * el país: es `'0'` en casi toda Europa y `'8'` en Rusia. Se aplica SIN comprobar largos, y
 * es deliberado: un número nacional no empieza NUNCA por su propio dígito de tronco —eso es
 * lo que significa ser un prefijo de salida— así que quitarlo no puede romper un número que
 * estuviera bien. La única excepción del mundo es Italia, cuyos fijos llevan el 0 dentro, y
 * por eso Italia declara `troncal: null`.
 *
 * **La versión con guarda de largo estuvo escrita, y era un bug.** «Solo quito el 0 si al
 * quitarlo el largo queda válido» funciona mientras el país tenga un largo único (España,
 * nueve), y falla en cuanto el rango es ancho: un móvil alemán con su tronco, `01701234567`,
 * mide once dígitos, once ESTÁ dentro del rango alemán [6, 11], así que el 0 se quedaba
 * dentro y salía `4901701234567`. Lo cazó medir el sabotaje —salió en 0 rojos, o sea que el
 * test no protegía nada— y no leyéndolo. Es la regla 2 del repo en una línea.
 */
function componerTelefono({ prefijo, numero } = {}) {
    const crudo = typeof numero === 'string' ? numero : '';
    // (1) Internacional declarado. `\D` se lleva el '+', así que hay que mirarlo ANTES.
    if (/^\s*(\+|00)/.test(crudo)) {
        const d = crudo.replace(/\D/g, '').replace(/^0+/, '');
        return d.length >= LARGO_MIN_E164 && d.length <= LARGO_MAX_E164
            ? { ok: true, telefono: d, internacional: true }
            : { ok: false, motivo: 'largo' };
    }

    const d = crudo.replace(/\D/g, '');

    // Sin país no se compone: se devuelve lo que hay y quien llama decide. Pasa en un solo
    // caso real —un navegador con el bundle viejo, en los minutos de un despliegue— y ahí lo
    // correcto es comportarse como ayer y DECIRLO, no tirarle la reserva a la clienta.
    const pais = PAISES.find(p => p.codigo === String(prefijo ?? ''));
    if (!pais) return { ok: true, telefono: d, sinPrefijo: true };

    if (!d) return { ok: false, motivo: 'vacio' };

    const cod = pais.codigo;
    const tro = pais.troncal;
    let nacional = d;
    // (a) el prefijo del país, si ya venía puesto. El '+1' de margen es para el tronco que
    //     pueda venir detrás.
    if (nacional.startsWith(cod)
        && dentroDe([pais.nsn[0], pais.nsn[1] + 1], nacional.length - cod.length)) {
        nacional = nacional.slice(cod.length);
    }
    // (b) el dígito de salida nacional. Sin guarda de largo: ver la cabecera.
    if (tro && nacional.length > 1 && nacional.startsWith(tro)) {
        nacional = nacional.slice(1);
    }
    if (!dentroDe(pais.nsn, nacional.length)) {
        return { ok: false, motivo: nacional.length > pais.nsn[1] ? 'largo' : 'corto' };
    }

    return { ok: true, telefono: cod + nacional };
}

// ─── Las proyecciones: qué sale a internet ───────────────────────────────────────────────
//
// LA REGLA, y es la que sostiene el test de fuga: **se enumeran los campos, jamás se
// esparce el objeto.** Un `{...entrada}` publica hoy lo que hay y mañana lo que alguien
// añada — y lo que se añade a `agent_configs.services` lo escribe la dueña desde el panel,
// sin pasar por aquí. Con un spread, el día que apunte un precio de coste o una nota interna
// en una entrada del catálogo, eso aparece en una página pública sin que nadie toque una
// línea de código.

/**
 * Lo poco que la página necesita saber DEL SALÓN, y ni un campo más.
 *
 * `business_info` es un JSONB que edita la dueña desde el panel: hoy tiene dentro el prompt
 * comercial, las reglas de upselling, el equipo, el enlace de reseñas y lo que escriba
 * mañana. Un `{...business_info}` publicaría todo eso, así que aquí se ENUMERAN dos cosas:
 *
 *   · `nombre`   — para la pantalla de confirmación («tu cita ha sido confirmada en Sante»).
 *     Sin `companyName` se devuelve **null** y la página dice la frase sin nombre: no se
 *     deriva del slug ni se escribe «Sante» en el código del panel, que sería una segunda
 *     copia de un dato que ella edita (regla 5).
 *   · `direccion` — para la pantalla de confirmación. Quien acaba de reservar necesita saber
 *     dónde va, y es un dato público (está en la puerta y en Google). Decisión del dueño,
 *     21/08/2026. Se limpia a una línea: va a un `<p>`, no a un parámetro de plantilla.
 *   · `whatsapp` — el enlace con el mensaje ya escrito. Va aquí, en la PRIMERA llamada de la
 *     página, para que la clienta tenga una salida humana aunque más tarde se caiga todo:
 *     una respuesta rota puede no traer enlace, y entonces la página usa el que guardó.
 *   · `puertas` — los dos enlaces de las salidas voluntarias (ver PUERTAS arriba).
 *
 * Lo demás de `business_info` no sale: ni el prompt comercial, ni el equipo, ni las reglas
 * de upselling, ni lo que la dueña escriba mañana sobre el JSONB.
 */
function salonPublico(businessInfo, { waPhone, lang } = {}) {
    const bi = (businessInfo && typeof businessInfo === 'object') ? businessInfo : {};
    const texto = (valor, max) => (typeof valor === 'string' && valor.trim()
        ? limpiarUnaLinea(valor, max) : null);
    return {
        nombre: texto(bi.companyName, MAX_NOMBRE),
        direccion: texto(bi.direccion, MAX_DIRECCION),
        whatsapp: enlaceWhatsApp(waPhone, 'generico', lang),
        puertas: Object.fromEntries(PUERTAS.map(p => [p, enlaceWhatsApp(waPhone, p, lang)])),
    };
}

/**
 * El catálogo que ve una desconocida. Entra ya FILTRADO por el call site
 * (`offerableCatalog`, que quita inactivos y `solo_complemento`) — el filtro no se hace aquí
 * a propósito: meterlo dentro de una proyección lo escondería del sitio donde se decide.
 *
 * `precio: null` («se confirma en salón», hoy solo la Consulta) se conserva como null y NO
 * se convierte en 0: un 0 € en una página pública es un precio inventado.
 *
 * ── `nombreCompleto`: EL nombre del servicio, y viene de aquí por obligación ─────────────
 *
 * Es lo que `buildFullServiceName` devuelve, o sea EXACTAMENTE la cadena que se escribirá en
 * `appointments.service`: la que el salón lee en la agenda, la que dice el recordatorio de
 * 24 h y contra la que la facturación casa EXACTO. La pantalla no puede calcularla:
 * `buildFullServiceName` cuenta homónimos sobre el catálogo COMPLETO —que esta ruta no
 * publica, y no debe— y una segunda copia de la regla en el navegador es la divergencia que
 * ya existe en `helpers.js` entre `SLOT_TEXTO_PARTES` y `_lineaCita`.
 *
 * Sin `nombrePara` el campo NO se inventa: se queda ausente y la pantalla cae al `nombre`
 * pelado, que es un valor real del catálogo. Lo que no puede volver a pasar es que alguien
 * componga un tercer nombre («Cortes · Mujer y secado») que no existe en ningún sitio.
 *
 * ── `explicacion`: el ÚNICO campo del catálogo que sale traducido ────────────────────────
 *
 * Escrito desde el 21/08/2026 en 21 de las 82 entradas. Ver `explicacionPublica`.
 */
function catalogoPublico(servicios = [], { clavePara = null, nombrePara = null, lang = null } = {}) {
    return (Array.isArray(servicios) ? servicios : []).map(s => {
        const fila = {
            categoria: s.categoria ?? null,
            nombre: s.nombre ?? null,
            precio: s.precio === undefined ? null : s.precio,
            duracion: s.duracion ?? null,
        };
        // La clave (`categoria|nombre`) se calcula AQUÍ, sobre la misma entrada de la que
        // sale el precio. Emparejarla por índice con la lista de entrada funcionaría hoy
        // —esta proyección mapea 1:1— pero el día que filtrara algo, cada servicio se
        // quedaría con la clave del de al lado: el precio de uno y la identidad de otro.
        if (clavePara) fila.key = clavePara(s);
        if (nombrePara) {
            const n = nombrePara(s);
            if (typeof n === 'string' && n.trim()) fila.nombreCompleto = n;
        }
        // Ausente cuando no hay nada escrito, NUNCA una cadena vacía: la pantalla decide si
        // pinta la línea preguntando si el campo está, y un '' pintaría un renglón en blanco
        // debajo de cada servicio del catálogo.
        const expl = explicacionPublica(s, lang);
        if (expl) fila.explicacion = expl;
        return fila;
    });
}

// ─── La explicación de un servicio: el hueco que rellena la dueña ────────────────────────
//
// **El nombre del servicio NO se traduce, y eso no se toca** — está escrito arriba y en
// nucleo.ts: el nombre que la clienta lee es EXACTAMENTE la cadena que se escribe en
// `appointments.service`, o sea la que el salón ve en la agenda, la que le dirá el
// recordatorio de 24 h y contra la que casa la facturación. Traducirlo la dejaría reservando
// «Осветление» y pidiendo en el mostrador algo que allí no se llama así.
//
// Lo que SÍ puede ir traducido es una línea DEBAJO del nombre, que explica qué es sin
// sustituirlo. **No se rellena desde el código**: el texto lo escribe Yulia, en el idioma del
// salón, y sin él no sale ninguna línea. Inventarle a un servicio una descripción que la
// dueña no ha escrito es exactamente la regla 3.
//
// Escrito el 21/08/2026 en 21 de las 82 entradas, y SOLO en castellano —los otros tres
// idiomas caen a él, que es lo que permite traducir después sin dejar la pantalla muda—:
// las variantes de las SEIS categorías que van por largo (hombros / espalda / cintura, con
// «o más» en las tres que no tienen cuarta variante, porque allí «Largo» es el techo al que
// el motor manda a quien dice «por debajo de la cintura») y las tres coberturas de mechas
// clásicas. **Las tres XL se quedaron sin línea a propósito**: la máquina las trata como
// largo 4 y el prompt le dice a la clienta que son cambio de color, y hasta que Yulia diga
// cuál de las dos es, una línea equivocada ahí cuesta entre 10 y 30 € dichos como precio
// bueno. Las demás entradas siguen sin el campo, y no sale nada por ellas.
//
// ── Vale para las dos cosas, y por eso no se llama `largo` ───────────────────────────────
//
// La tentación era un campo «largo» con hombros/espalda/cintura dentro, porque el caso que
// trajo esto son las variantes que dicen Corto/Medio/Largo/XL. Sería falso en la mitad del
// catálogo: de las 15 categorías con varias entradas, solo 6 van por largo. En «Mechas
// clásicas» las tres variantes son COBERTURA (delante y rostro / media cabeza / cabeza
// completa), en «Cortes» son cinco servicios distintos y en «Manicura/Pedicura» son diez.
// Un rótulo que preguntara «¿qué largo tienes?» mentiría en nueve de las quince. Así que el
// campo es texto libre por ENTRADA y neutro: dice lo que esa entrada necesite decir.
//
// ── Vive en la ENTRADA, no en una tabla por categoría ────────────────────────────────────
//
// Misma doctrina que `solo_complemento` y por el mismo motivo: la categoría la edita la
// dueña sobre el JSONB, y una tabla del código indexada por su nombre deja de casar el día
// que la renombre — en silencio, que es lo caro (regla 5). Ya hay dos así en el repo, las
// dos anotadas como fragilidad: `REACTIVE_ONLY_CATEGORIES` y `COBERTURA_MECHAS_CLASICAS`
// (`openai.js`), que es justo la explicación de las mechas clásicas escrita a mano en git.
//
// ── Y por qué NO se reutiliza lo que el bot ya dice ──────────────────────────────────────
//
// El bot sí explica el largo, en `openai.js:661-665`, y no sirve para esto por tres motivos,
// cada uno suficiente: (1) no es un dato sino tres frases en castellano DENTRO del prompt,
// que el modelo reescribe y traduce sobre la marcha —una página no tiene modelo—; (2) no es
// por entrada sino por FORMA de la categoría (si tiene una 4ª variante, y si esa 4ª es XL);
// y (3) cubre solo el largo. Lo que sí se puede reutilizar es su CONTENIDO cuando Yulia
// escriba el hueco: hombros / espalda / cintura, con el XL que es cambio de color y no
// longitud. Esa decisión es suya, no del código.
//
// ── La forma ─────────────────────────────────────────────────────────────────────────────
//
//   explicacion: { es: '…', en: '…', ru: '…', uk: '…' }     ← lo normal
//   explicacion: 'hasta los hombros'                        ← atajo, equivale a { es: … }
//
// Falta un idioma → cae al castellano, con el mismo criterio que `textos()` en la pantalla:
// una explicación en castellano para una rusa es peor que en ruso y MEJOR QUE NINGUNA, y
// sobre todo permite que Yulia escriba primero el castellano y traduzca después sin que la
// pantalla se quede muda entremedias. Falta también el castellano → no sale línea.
//
// Sale SANEADA: una línea y 140 caracteres. Es texto libre de la dueña en una página
// pública, así que el tope no es cosmético — sin él, un párrafo pegado en el JSONB empuja
// cada fila de la lista y deja la pantalla inservible en un móvil.
function explicacionPublica(entrada, lang) {
    const v = entrada && entrada.explicacion;
    const limpiar = txt => (typeof txt === 'string' && txt.trim()
        ? (limpiarUnaLinea(txt, MAX_EXPLICACION) || null) : null);
    if (typeof v === 'string') return limpiar(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        return limpiar(v[idiomaValido(lang)]) || limpiar(v.es);
    }
    return null;
}

/** La rejilla de mes. Un día es una fecha, un número y quién puede atenderlo. */
function diasPublicos(dias = []) {
    return (Array.isArray(dias) ? dias : []).map(d => ({
        fecha: d.fecha,
        huecos: d.huecos,
        estilistas: (d.estilistas || []).map(e => ({ id: e.id, nombre: e.name })),
    }));
}

/**
 * Los huecos de un día. **`texto` se queda fuera a propósito**: lo fabrica el motor para que
 * el bot se lo recite al modelo, y aquí sobra — la página pinta una hora en una cuadrícula,
 * no una frase. Publicarlo sería mandar prosa a un sitio que solo necesita datos.
 */
function huecosPublicos(slots = []) {
    return (Array.isArray(slots) ? slots : []).map(s => ({
        fecha: s.fecha,
        hora: s.hora,
        estilistas: (s.alternativas || [{ id: s.stylistId, name: s.stylistName }])
            .map(e => ({ id: e.id, nombre: e.name })),
    }));
}

/**
 * El acuse de una reserva hecha. **No lleva el nombre de nadie, y eso no es un descuido.**
 * Si el teléfono casaba con una ficha, la página NO puede saludar por su nombre: eso
 * filtraría el nombre de una clienta a cualquiera que teclee su número. Se devuelve lo que
 * ELLA acaba de elegir —fecha, hora, servicio, estilista— y nada que estuviera guardado.
 */
function reservaPublica({ fecha, hora, cuando, servicio, estilistaNombre, duracionMin }) {
    return {
        ok: true,
        cita: {
            fecha, hora,
            // `cuando` es «10:00 del jueves 10 de septiembre», y lo fabrica `formatReminderWhen`
            // en el call site. Viaja HECHO a propósito: es la misma frase que le llegará en el
            // recordatorio de 24 h, y esa tabla de días existe porque el ruso y el ucraniano
            // piden acusativo detrás de la preposición. Que la pintara el navegador con un
            // `toLocaleDateString` sería la segunda tabla que CLAUDE.md prohíbe, y el mismo
            // jueves saldría de dos formas a la misma clienta. Un null aquí NO bloquea nada:
            // la página enseña la fecha y la hora sueltas, que es el lado recuperable.
            cuando: cuando ?? null,
            servicio: servicio ?? null,
            estilista: estilistaNombre ?? null,
            duracionMin: duracionMin ?? null,
            zonaHoraria: BUSINESS_TZ,
        },
    };
}

// ─── Validación de lo que entra ──────────────────────────────────────────────────────────

// Tope del texto libre. `notas` va a la ficha del panel y NUNCA a un parámetro de plantilla
// de Meta (un salto de línea ahí hace que rechacen el mensaje entero, error 132000), pero
// eso no lo garantiza el destino: lo garantiza que aquí entre acotado y en una sola línea.
const MAX_NOTAS = 300;
const MAX_NOMBRE = 80;
// La dirección la escribe la dueña y va a una página pública: acotada y en una línea.
const MAX_DIRECCION = 160;
// La explicación de un servicio: la escribe la dueña, va a una página pública y tiene que
// caber DEBAJO de un nombre sin empujar la fila. Una línea, y corta.
const MAX_EXPLICACION = 140;

// El largo de un E.164: entre 8 y 15 dígitos con el prefijo dentro. Solo lo usa el camino
// internacional de `componerTelefono` —el que se fía de lo que ella escribió tras el '+'—,
// porque ahí no hay país contra el que comprobar nada más. Los demás caminos comprueban el
// largo NACIONAL contra `nsn`, que es mucho más estrecho y por tanto mejor.
const LARGO_MIN_E164 = 8;
const LARGO_MAX_E164 = 15;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function limpiarUnaLinea(txt, max) {
    return String(txt).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

module.exports = {
    MOTIVOS, POLITICA, MOTIVOS_SQL, LIMITES_DEFAULT,
    interpretarMotivoSql, enlaceWhatsApp, respuestaNo,
    resolverLimites, crearLimitador,
    crearCandadoReserva, claveDeReserva, CANDADO_TTL_MS,
    catalogoPublico, diasPublicos, huecosPublicos, reservaPublica, salonPublico,
    explicacionPublica,
    PAISES, PAIS_POR_DEFECTO, paisesPublicos, componerTelefono,
    limpiarUnaLinea, idiomaValido,
    MAX_NOTAS, MAX_NOMBRE, MAX_DIRECCION, MAX_EXPLICACION,
    FECHA_RE, HORA_RE, UUID_RE, HORA_MS, PUERTAS, IDIOMAS,
};
