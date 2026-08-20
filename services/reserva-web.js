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
 *   · `whatsapp` — el enlace con el mensaje ya escrito. Va aquí, en la PRIMERA llamada de la
 *     página, para que la clienta tenga una salida humana aunque más tarde se caiga todo:
 *     una respuesta rota puede no traer enlace, y entonces la página usa el que guardó.
 *
 * La DIRECCIÓN no sale: no hace falta para nada de lo que la pantalla enseña hoy, y cada
 * campo que se publica es un campo que hay que vigilar.
 */
function salonPublico(businessInfo, { waPhone, lang } = {}) {
    const bi = (businessInfo && typeof businessInfo === 'object') ? businessInfo : {};
    const nombre = typeof bi.companyName === 'string' && bi.companyName.trim()
        ? bi.companyName.trim() : null;
    return { nombre, whatsapp: enlaceWhatsApp(waPhone, 'generico', lang) };
}

/**
 * El catálogo que ve una desconocida. Entra ya FILTRADO por el call site
 * (`offerableCatalog`, que quita inactivos y `solo_complemento`) — el filtro no se hace aquí
 * a propósito: meterlo dentro de una proyección lo escondería del sitio donde se decide.
 *
 * `precio: null` («se confirma en salón», hoy solo la Consulta) se conserva como null y NO
 * se convierte en 0: un 0 € en una página pública es un precio inventado.
 */
function catalogoPublico(servicios = [], clavePara = null) {
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
        return fila;
    });
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
    limpiarUnaLinea, idiomaValido,
    MAX_NOTAS, MAX_NOMBRE, FECHA_RE, HORA_RE, UUID_RE, HORA_MS,
};
