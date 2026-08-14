/**
 * verify-sante-robustez-llm.js — NIVEL B de la prueba en seco adversarial.
 *
 * Conduce conversaciones COMPLETAS (LLM real + sesión real) con input que una clienta
 * escribiría y que nadie ha probado. No afirma textos concretos: clasifica el resultado.
 *
 *   OK          el bot responde algo útil y relacionado con lo que se le pidió
 *   DEGRADADO   responde, pero con un genérico inútil ("no he podido procesar", "¿cuál de
 *               los horarios disponibles?" sin lista) o anuncia avería técnica sin haberla
 *   SILENCIO    no responde nada
 *   BUCLE       repite una pregunta que ya había hecho, tras una respuesta de la clienta
 *   BUG         fallo real y demostrado (no una degradación): hace fallar el proceso, igual
 *               que en el nivel A. Un escenario que use BUG tiene que fallar SIN el arreglo
 *               y pasar CON él; si no, no está probando nada.
 *
 * La agenda se sintetiza (stub de la capa db) para poder forzar escenarios imposibles de
 * reproducir con la agenda real: salón completamente lleno, estilista sin horario, etc.
 * El LLM y toda la lógica del bot son reales.
 *
 * Uso:  npm run verify:robustez:llm                     (todos)
 *       npm run verify:robustez:llm -- 7                (solo el escenario 7)
 *       npm run verify:robustez:llm -- 5-12             (un rango)
 *       npm run verify:robustez:llm -- familia:C        (una familia de causa)
 *       npm run verify:robustez:llm -- idioma:ru        (un idioma de clienta)
 *       npm run verify:robustez:llm -- shard:2/6        (porción 2 de 6 — paralelización
 *                                                        por procesos, aún sin estrenar)
 *   Requiere OPENROUTER_API_KEY + Supabase. Consume tokens y tarda varios minutos.
 *
 *   Un DEGRADADO a la primera se REPITE solo antes de contarlo (la doctrina del degradado
 *   que baila); tres escenarios seguidos con el fallback del modelo ABORTAN la corrida con
 *   exit 2 (proveedor caído, no regresión). La parte pura de esas políticas vive en
 *   tests/lib/robustez-llm-helpers.js, con su test determinista.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

// ─── Telegram INERTE, por construcción ───────────────────────────────────────────────
// Hoy ya lo era de facto: sin startTelegramBot, `_botInstance` es null y notifyOrgAdmin
// avisa y devuelve false. Pero esa inercia era un accidente del orden de arranque, y una
// tanda de 100 escenarios con 5-6 workers no puede depender de un accidente: si algún día
// alguien llama a initSendOnlyBot en un require intermedio, cada escenario de escalada le
// mandaría un Telegram DE VERDAD a Yulia. El stub lo hace imposible desde este proceso.
// (Auditado el 14/08/2026: el arnés tampoco puede mandar WhatsApps — el cliente es un
// sink, bot.js no usa resolveOutboundClient, y aquí no se arranca ningún worker.)
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: {
        notifyBizumPending: async () => {}, notifyEscalation: async () => {},
        notifyBlacklistAlert: async () => {}, notifyVipSuggestion: async () => {},
        notifyOrgAdmin: async () => false, startTelegramBot: () => {},
        initSendOnlyBot: async () => { throw new Error('telegram deshabilitado en el arnés'); },
    },
};

const bot = require('../bot');
const db = require('../services/db');
const supabase = require('../services/supabase');
const { deleteClient } = require('../services/memory');
const { SANTE_ORG_ID: ORG } = require('../services/org-registry');
const { TEST_PHONE_PREFIX } = require('../services/helpers');
const helpers = require('../services/helpers');
const { Convo: BaseConvo, sleep } = require('./lib/convo');
const {
    esFallbackLLM, CorteProveedor, CORTE_PROVEEDOR_UMBRAL, debeReintentar,
    parseSeleccion, matchesSeleccion, resumenAgrupado,
} = require('./lib/robustez-llm-helpers');

bot.setBotActivo(ORG, true, false);

class Convo extends BaseConvo {
    constructor(phone) { super(phone, ORG); }
}

// ─── Clasificación ───────────────────────────────────────────────────────────────────
const results = [];
// BUG existía en el nivel A pero no aquí, así que un rec('BUG') imprimía "undefined", no
// contaba en el resumen y no rompía el proceso: un escenario que detectara un fallo real
// pasaba inadvertido. Con la misma semántica que en verify-sante-robustez.js — BUG hace
// fallar el proceso a propósito.
const ICON = { OK: '✅', DEGRADADO: '⚠️ ', SILENCIO: '🔇', BUCLE: '🔁', ERROR: '💥', BUG: '🐞' };

const norm = t => String(t || '').toLowerCase().replace(/[^\wáéíóúñ ]+/gi, '').replace(/\s+/g, ' ').trim();

// Genéricos que indican que el bot no supo seguir.
const GENERICOS = [
    /no he podido procesar/i,
    /no he podido fijar ese hueco/i,
    /cu[aá]l de los horarios disponibles/i,
    /problema t[eé]cnico/i,
    /se me ha ido la conexi[oó]n/i,
    /qu[eé] d[ií]a o semana te viene mejor/i,
];
const esGenerico = t => GENERICOS.some(re => re.test(t || ''));

// ¿El bot repitió una pregunta que ya había hecho? Compara la última respuesta con las
// anteriores del mismo hilo (ignorando la inmediatamente previa, que puede ser un split).
function detectaBucle(convo) {
    const msgs = convo.allBotMsgs.map(norm).filter(m => m.length > 25);
    for (let i = 2; i < msgs.length; i++) {
        for (let j = 0; j < i - 1; j++) {
            if (msgs[i] === msgs[j]) return `repitió: "${convo.allBotMsgs[i].slice(0, 60)}…"`;
        }
    }
    return null;
}

// ─── Agenda sintética ────────────────────────────────────────────────────────────────
const SCHEDULE_ABIERTO = [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00:00', end_time: '19:00:00' }));

function stubAgenda({ stylists, schedule = SCHEDULE_ABIERTO, appointments = [] }) {
    const real = {
        getStylistsByOrg: db.getStylistsByOrg,
        getStylistSchedule: db.getStylistSchedule,
        getBlockedDays: db.getBlockedDays,
        getScheduleBlocks: db.getScheduleBlocks,
        getAppointmentsByStylistAndRange: db.getAppointmentsByStylistAndRange,
    };
    db.getStylistsByOrg = async () => stylists;
    db.getStylistSchedule = async () => schedule;
    db.getBlockedDays = async () => [];
    db.getScheduleBlocks = async () => [];
    db.getAppointmentsByStylistAndRange = async (...a) =>
        (typeof appointments === 'function' ? appointments(...a) : appointments);
    return () => Object.assign(db, real);
}

const addDays = (dateStr, n) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};

// Tapa 08:00–21:00 todos los días del rango → salón literalmente lleno.
const AGENDA_LLENA = (_o, stylistId, from, to) => {
    const out = [];
    let d = String(from).slice(0, 10);
    const end = String(to).slice(0, 10);
    while (d <= end) {
        out.push({ id: `full${d}`, stylist_id: stylistId, status: 'confirmed', service: 'ocupado',
            starts_at: `${d}T06:00:00.000Z`, ends_at: `${d}T20:00:00.000Z` });
        d = addDays(d, 1);
    }
    return out;
};

/**
 * ¿Se escribió alguna cita a nombre de nadie?
 *
 * Es la única comprobación de este fichero que NO depende de cómo redacte el LLM. El fallo
 * del 02/08 no fue un texto raro: fue una fila en `appointments` con la clienta sin nombre.
 * Clasificar eso por regex (/✅|reservada/) deja pasar cualquier confirmación redactada de
 * otra forma —"te espero el lunes a las 10 con Irina"— con la cita ya escrita: verde con el
 * agujero abierto. Aquí se mira la fila.
 *
 * El stub de agenda solo tapa las LECTURAS (horarios, huecos). `saveLead`/`saveAppointment`
 * son reales, así que estas filas existen de verdad en Supabase mientras dura la prueba;
 * `cleanup()` las borra al empezar cada escenario.
 */
// Forma exacta del fallo del 02/08 (fila 9aa5ee32 de producción, "Orising hidratación
// intensa" del 05/08): `appointments.full_name` = CADENA VACÍA y `contacts.full_name` = null.
// La columna de la cita es NOT NULL, así que el nombre que falta no llega como null sino
// como "" — buscar `is null` solo no habría encontrado nada. Se miran las dos, porque la
// que lee el salón es la de la cita y la que usa el bot para saludar es la del contacto.
const nombreEnBlanco = v => {
    const s = String(v ?? '').trim();
    return !s || ['null', 'undefined'].includes(s.toLowerCase());
};

async function citasSinNombre(phones) {
    const digits = phones.map(p => String(p).replace(/\D/g, ''));
    const { data: contactos } = await supabase
        .from('contacts').select('id, wa_phone, full_name')
        .eq('organization_id', ORG).in('wa_phone', digits);
    if (!contactos || !contactos.length) return [];
    const porId = new Map(contactos.map(c => [c.id, c]));
    const { data: citas } = await supabase
        .from('appointments').select('id, contact_id, full_name, service, starts_at')
        .eq('organization_id', ORG).in('contact_id', [...porId.keys()]);
    return (citas || [])
        .filter(a => nombreEnBlanco(a.full_name) || nombreEnBlanco((porId.get(a.contact_id) || {}).full_name))
        .map(a => ({ ...a, telefono: (porId.get(a.contact_id) || {}).wa_phone }));
}

async function cleanup(phone) {
    const digits = phone.replace(/\D/g, '');
    try {
        const c = await db.findByPhone(ORG, digits);
        if (c) {
            await supabase.from('appointments').delete().eq('organization_id', ORG).eq('contact_id', c.id);
            await supabase.from('pending_actions').delete().eq('organization_id', ORG).eq('contact_id', c.id);
            await supabase.from('contacts').delete().eq('organization_id', ORG).eq('id', c.id);
        }
    } catch { /* limpieza best-effort */ }
    deleteClient(ORG, `${digits}@c.us`);
}

// Margen para que aterrice lo que quedó en vuelo (el último turno, su saveMessage saliente y
// el UPDATE de la conversación). No hay evento al que engancharse: son promesas con `.catch()`
// que nadie espera. Generoso a propósito — corre UNA vez al final de una tirada de minutos.
const ASENTAMIENTO_MS = 8000;

// Borra TODO contacto de la org cuyo teléfono esté en el rango del arnés. Devuelve los
// teléfonos borrados para poder decirlo en voz alta.
//
// Basta con borrar el contacto: las FK de conversations, messages, appointments y
// pending_actions van en CASCADE (verificado el 05/08/2026), así que no quedan huérfanos.
// `broadcast_sends` es SET NULL y conserva el teléfono, que es lo que se quiere: si un número
// de prueba llegó a recibir algo, ese rastro no se borra solo.
async function barrerContactosDePrueba() {
    const { data, error } = await supabase
        .from('contacts')
        .select('id, wa_phone')
        .eq('organization_id', ORG)
        .like('wa_phone', `${TEST_PHONE_PREFIX}%`);
    if (error) {
        console.log(`\n  ⚠️  no se pudo barrer contactos de prueba: ${error.message}`);
        return [];
    }
    const borrados = [];
    for (const fila of data || []) {
        const { error: delError } = await supabase
            .from('contacts').delete().eq('organization_id', ORG).eq('id', fila.id);
        if (delError) {
            console.log(`\n  ⚠️  quedó sin borrar ${fila.wa_phone}: ${delError.message}`);
            continue;
        }
        deleteClient(ORG, `${fila.wa_phone}@c.us`);
        borrados.push(fila.wa_phone);
    }
    return borrados;
}

let seq = 0;
// Estos escenarios corren contra la Supabase REAL de Sante —es lo que les da valor: catálogo,
// estilistas y horarios de verdad, que la dueña edita—, así que cada conversación crea un
// contacto real. Y la limpieza tiene una carrera que no se puede cerrar del todo: `saveMessage`
// es fire-and-forget y el turno sigue vivo después del `finally`, así que una escritura en vuelo
// puede RESUCITAR el contacto justo después de borrarlo (pasa siempre en el escenario de la
// ráfaga, que por definición deja trabajo fuera de la ventana del buffer).
//
// Por eso el número importa: el rango de antes (`3460099xxxx`) era un móvil español plausible,
// y un residuo se colaba en la audiencia de una campaña como una clienta más. `999` es un código
// de país sin asignar en E.164 — no puede ser de nadie —, y db.getBroadcastRecipients excluye
// ese prefijo de toda audiencia. Dos redes: aunque el residuo se quede, no le llega nada a nadie.
// El dígito central identifica el SHARD (0 = corrida entera): dos workers en paralelo no
// pueden compartir teléfonos de prueba — el cleanup de uno borraría al contacto vivo del
// otro en mitad de su conversación. Máximo 9 shards, que sobra para 5-6 workers.
const shardDigit = () => seleccion?.shard?.i ?? 0;
const nextPhone = () => `${TEST_PHONE_PREFIX}6${shardDigit()}0${String(1000 + (seq++)).slice(-4)}`;

// Selección: número, rango (5-12), familia:C, idioma:ru, shard:i/n — combinables.
// `shard:i/n` es la pieza de la PARALELIZACIÓN por procesos (i-ésimo de n, por número de
// escenario módulo n): escrita el 14/08/2026 y aún sin conducir en paralelo contra nada
// real. El día que se estrene: N procesos `node tests/verify-sante-robustez-llm.js
// shard:i/N`, cada uno con su rango de teléfonos, y sumar los resúmenes.
const seleccion = parseSeleccion(process.argv.slice(2));
if (seleccion === null) {
    console.error('Uso: verify:robustez:llm [n] [a-b] [familia:X] [idioma:xx] [shard:i/n]');
    process.exit(1);
}
// Teléfonos que ha usado esta ejecución: al final se barren todos contra `citasSinNombre`.
// Un escenario cualquiera puede acabar reservando aunque no vaya de eso, y una cita a nombre
// de nadie es un fallo se llame como se llame el escenario que la provocó.
const telefonosUsados = [];
let idx = 0;

// Un intento aislado del escenario: teléfono propio, Convo propia, veredicto propio.
// Extraído de escenario() para poder REPETIR un DEGRADADO sin arrastrar estado.
async function intento(fn) {
    const phone = nextPhone();
    telefonosUsados.push(phone);
    await cleanup(phone);
    const c = new Convo(phone);

    // Cada intento se clasifica UNA sola vez: la primera llamada gana, para que un
    // `return rec(...)` temprano no se vea pisado por la detección de bucle posterior.
    let out = null;
    const rec = (estado, nota) => { if (!out) out = { estado, nota: nota || '' }; };

    try {
        await fn(c, rec, phone);
        // Un bucle solo tiene sentido si el escenario no falló ya por otra vía.
        const bucle = detectaBucle(c);
        if (bucle && !out) rec('BUCLE', bucle);
        if (!out) rec('OK');
    } catch (e) {
        // Un error de ejecución manda sobre cualquier veredicto ya emitido.
        out = { estado: 'ERROR', nota: e.message };
    } finally {
        await cleanup(phone);
        await sleep(500);
    }
    // ¿Contestó el FALLBACK del modelo en algún turno? Es la señal del corte por
    // proveedor caído — se mira aquí porque el texto vive en la conversación, no en la nota.
    out.fallbackLLM = esFallbackLLM(c.allBotMsgs);
    return out;
}

// Corte por proveedor caído: N escenarios seguidos contestando el fallback del modelo no
// miden el salón. Hasta hoy era una instrucción de lectura («mirar si el degradado es
// siempre la misma frase y esperar»); con ~100 escenarios tiene que ser código, porque
// nadie va a leer 30 rojos idénticos para deducirlo.
const corteProveedor = new CorteProveedor();
function abortarPorProveedor() {
    console.log('\n' + '═'.repeat(78));
    console.log(`💥 CORRIDA ABORTADA: ${CORTE_PROVEEDOR_UMBRAL} escenarios seguidos con el fallback del modelo.`);
    console.log('   Eso no es una regresión del salón: el proveedor está caído o limitando.');
    console.log('   Espera y repite. Los veredictos impresos hasta aquí siguen siendo válidos.');
    console.log('═'.repeat(78) + '\n');
    process.exit(2);
}

// escenario('nombre', fn) — compat — o escenario('nombre', { familia, idioma }, fn).
// familia ∈ {A,B,C,D,E,control} (las cinco causas de las auditorías); idioma = el de la
// CLIENTA en el escenario. Salen en el resumen agrupado y sirven de selector.
async function escenario(nombre, meta, fn) {
    if (typeof meta === 'function') { fn = meta; meta = {}; }
    idx++;
    const n = idx;
    const familia = meta.familia || null;
    const idioma = meta.idioma || null;
    if (!matchesSeleccion(seleccion, { n, familia, idioma })) return;
    console.log(`\n▶ ${n}. ${nombre}`);

    let r = await intento(fn);
    // La doctrina del degradado que baila, automatizada: un DEGRADADO suelto se repite
    // ANTES de contarlo — dos corridas con el mismo escenario degradado sí se persiguen.
    // Solo DEGRADADO: la fila dura (BUG/SILENCIO/BUCLE/ERROR) no se reintenta jamás; un
    // fallo intermitente de esa fila es un hallazgo, no ruido.
    if (debeReintentar(r.estado)) {
        console.log(`  🔁 DEGRADADO a la primera («${r.nota.slice(0, 60)}») — se repite antes de contarlo`);
        const r2 = await intento(fn);
        r = r2.estado === 'OK'
            ? { ...r2, nota: `OK al repetir · la 1ª corrida degradó: ${r.nota}`.trim() }
            : { ...r2, nota: `PERSISTE en 2 corridas · ${r2.nota}`.trim() };
    }

    results.push({ n, nombre, estado: r.estado, nota: r.nota, familia, idioma });
    console.log(`  ${ICON[r.estado]} ${r.estado}${r.nota ? ` — ${r.nota}` : ''}`);
    if (corteProveedor.registra(r.fallbackLLM && r.estado !== 'OK')) abortarPorProveedor();
}

// Envía y clasifica en un solo paso: comprueba silencio y genéricos.
async function turno(c, texto) {
    const msgs = await c.send(texto);
    const txt = msgs.join(' ');
    return { msgs, txt, vacio: msgs.length === 0, generico: esGenerico(txt), incluye: re => re.test(txt) };
}

(async () => {
    if (!process.env.OPENROUTER_API_KEY) { console.error('❌ Falta OPENROUTER_API_KEY'); process.exit(1); }
    const stylists = await db.getStylistsByOrg(ORG);
    const cfg = await db.getAgentConfig(ORG);
    const catalog = cfg?.services || [];
    const pelo = stylists.filter(s => (s.skills || []).some(k => /^cortes$/i.test(k)));
    console.log(`\nSante · ${catalog.length} servicios · ${stylists.length} estilistas · ${pelo.length} para cortes\n`);
    console.log('Agenda SINTÉTICA (10–19 los 7 días) salvo donde el escenario diga lo contrario.\n');

    let restore = stubAgenda({ stylists });

    // ── 1-4 · Reconocimiento de servicio ────────────────────────────────────────────
    await escenario('Servicio inexistente ("un piercing")', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'quiero hacerme un piercing');
        if (r.vacio) return rec('SILENCIO');
        // Debe decir que no lo hace u ofrecer lo que sí hace, no callarse ni divagar.
        if (/no (lo )?(hacemos|ofrecemos|tenemos)|no traba|no dispon|ofrec|tenemos/i.test(r.txt)) rec('OK', 'reconduce');
        else if (r.generico) rec('DEGRADADO', r.txt.slice(0, 80));
        else rec('OK', r.txt.slice(0, 80));
    });

    await escenario('Servicio ambiguo ("algo para el pelo")', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'buenas');
        const r = await turno(c, 'quiero algo para el pelo pero no sé qué');
        if (r.vacio) return rec('SILENCIO');
        if (r.generico) return rec('DEGRADADO', r.txt.slice(0, 80));
        rec('OK', r.txt.slice(0, 90));
    });

    // Este check NO mira si el modelo escribe la palabra "balayage" en su respuesta. Eso es
    // redacción, y medirlo así daba DEGRADADO en 1 de cada 3 corridas (05/08/2026) con el bot
    // haciendo exactamente lo correcto: reconocía el typo y preguntaba el largo, pero sin
    // nombrar el servicio. Un check que falla por cómo redacta el modelo enseña a ignorar los
    // degradados, que es peor que no tenerlo.
    //
    // Lo que se afirma es la CONDUCTA, en el estado y no en la prosa: el typo entra en el flujo
    // de largo y, al contestarlo, el servicio queda RESUELTO en la sesión con la categoría del
    // catálogo — en vez de reconducir a "¿qué servicio quieres?", que es el fallo real que este
    // escenario busca. `selectedService` no depende de cómo redacte el modelo.
    await escenario('Servicio con falta de ortografía ("valayage")', { familia: 'C', idioma: 'en' }, async (c, rec) => {
        // La categoría se saca del CATÁLOGO, no de una constante escrita aquí: si la dueña
        // renombra el servicio, el escenario deja de aplicar en vez de quedarse en rojo para
        // siempre (los datos que ella edita no se verifican contra listas fijas).
        const catBalayage = [...new Set(catalog.map(s => s.categoria).filter(Boolean))]
            .find(cat => /balayage/i.test(cat));
        if (!catBalayage) return rec('OK', 'el catálogo ya no tiene balayage: escenario no aplicable');

        await turno(c, 'hola');
        const r = await turno(c, 'kiero un valayage');
        if (r.vacio) return rec('SILENCIO');
        if (r.generico) return rec('DEGRADADO', r.txt.slice(0, 80));

        // El largo es lo que el flujo de balayage pregunta; contestarlo es el turno en el que
        // el servicio tiene que aterrizar en la sesión. Si el bot hubiera reconducido a
        // catálogo, aquí no hay nada que resolver y selectedService se queda a null.
        const r2 = await turno(c, 'medio');
        if (r2.vacio) return rec('SILENCIO', 'se calló al contestar el largo');

        // La nota tiene que decir CUÁL de los dos fallos posibles fue, o el rojo no se puede
        // leer: que no reconociera el typo (el asunto del escenario) o que lo reconociera y
        // el servicio no aterrizara en la sesión. Por eso van los dos turnos en el mensaje.
        const svc = bot._internals.getSession(ORG, c.phone)?.selectedService;
        if (!svc) {
            return rec('DEGRADADO',
                `servicio sin resolver tras el largo · T2:"${r.txt.slice(0, 45)}" → T3:"${r2.txt.slice(0, 45)}"`);
        }
        if (norm(svc.categoria) !== norm(catBalayage)) {
            return rec('DEGRADADO', `resolvió "${svc.categoria} · ${svc.nombre}" y no ${catBalayage}`);
        }
        rec('OK', `${svc.categoria} · ${svc.nombre}${svc.precio ? ` (${svc.precio} €)` : ''}`);
    });

    await escenario('Cambio de opinión en mitad del flujo', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola, soy Ana');
        await turno(c, 'quiero un corte de mujer');
        const r = await turno(c, 'uy no, mejor unas mechas balayage');
        if (r.vacio) return rec('SILENCIO');
        rec(/balayage/i.test(r.txt) ? 'OK' : 'DEGRADADO', r.txt.slice(0, 90));
    });

    // ── 5-8 · Estilista ──────────────────────────────────────────────────────────────
    await escenario('Estilista mal escrita ("con Olga" → Olgha)', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola soy Marta');
        await turno(c, 'quiero una manicura');
        const r = await turno(c, 'con Olga por favor');
        if (r.vacio) return rec('SILENCIO');
        // Lo correcto es confirmar Olgha o preguntar; lo malo es ignorarlo en silencio.
        if (/olgha|olga/i.test(r.txt)) rec('OK', 'menciona a la estilista');
        else rec('DEGRADADO', `ignora la petición: "${r.txt.slice(0, 80)}"`);
    });

    await escenario('Estilista inexistente ("con Carmen")', { familia: 'A', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'quiero un corte de mujer');
        const r = await turno(c, 'con Carmen');
        if (r.vacio) return rec('SILENCIO');
        if (/no (tengo|trabaja|hay)|no est|no la|carmen/i.test(r.txt)) rec('OK', 'lo comenta');
        else rec('DEGRADADO', `no dice que Carmen no existe: "${r.txt.slice(0, 70)}"`);
    });

    // CONTROL de no regresión: el camino que SIEMPRE funcionó debe seguir igual. Si el
    // reconocimiento tolerante se pasara de laxo, aquí aparecería una "corrección" sobre
    // un nombre que ya estaba bien escrito, o una lista de alternativas que sobra.
    await escenario('CONTROL · estilista correcta ("con Irina") sin corregir nada', { familia: 'control', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola soy Elena');
        await turno(c, 'quiero un corte de mujer');
        const r = await turno(c, 'con Irina');
        if (r.vacio) return rec('SILENCIO');
        if (/no tengo|no hay nadie|te refieres/i.test(r.txt)) {
            return rec('DEGRADADO', `duda de un nombre correcto: "${r.txt.slice(0, 70)}"`);
        }
        rec(/irina/i.test(r.txt) ? 'OK' : 'DEGRADADO', r.txt.slice(0, 90));
    });

    await escenario('Estilista sin la skill ("mechas con Larisa")', { familia: 'A', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola soy Rosa');
        const r = await turno(c, 'quiero mechas balayage con Larisa');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    await escenario('Estilista primero, servicio después (orden invertido)', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'quiero pedir hora con Larisa');
        const r = await turno(c, 'para unas mechas');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    // ── 9-12 · Fecha y hora ──────────────────────────────────────────────────────────
    await escenario('"quiero cita hoy"', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola soy Lucía');
        await turno(c, 'un corte de mujer');
        const r = await turno(c, 'quiero cita hoy si puede ser');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    await escenario('"el finde"', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'un corte de mujer');
        const r = await turno(c, 'me viene bien el finde');
        if (r.vacio) return rec('SILENCIO');
        rec(/s[aá]bado|domingo|finde|fin de semana/i.test(r.txt) ? 'OK' : 'DEGRADADO', r.txt.slice(0, 90));
    });

    // Olga Yarmak, 07/08/2026: dijo TRES veces que solo podía «después de las 23:00» y las
    // tres recibió "no te entiendo". Se afirma el HECHO —que se le dice el horario real—, no
    // la redacción: las horas se leen de business_hours (que edita la dueña), así que un
    // cambio de horario en el panel no deja este escenario en rojo permanente.
    await escenario('Hora fuera del horario ("solo puedo después de las 23:00")', { familia: 'A', idioma: 'es' }, async (c, rec) => {
        const cfgH = (await db.getAgentConfig(ORG))?.business_hours || {};
        const dia = cfgH.lunes || Object.values(cfgH)[0];
        if (!dia?.apertura || !dia?.cierre) return rec('OK', 'sin business_hours: escenario no aplicable');
        await turno(c, 'hola');
        await turno(c, 'un corte de mujer');
        const r = await turno(c, 'solo puedo después de las 23:00');
        if (r.vacio) return rec('SILENCIO');
        // Las DOS puntas: decir que está cerrado sin decir hasta cuándo abren obliga a
        // preguntar otra vez, que es el turno que este arreglo existe para ahorrar.
        const dice = r.txt.includes(dia.apertura) && r.txt.includes(dia.cierre);
        rec(dice ? 'OK' : 'DEGRADADO', `${dia.apertura}-${dia.cierre} · ${r.txt.slice(0, 70)}`);
    });

    // Esther Cediloo (19723581589, 08/08/2026) quería nombrar a DOS personas en una reseña de
    // Google. El bot sabía una (Natalia, sus dos citas del día están a su nombre) y de la otra
    // contestó «I'm not sure I have that information 😊 Could you describe what service she
    // did?». No hay arreglo de datos posible: la segunda persona no está registrada en ningún
    // sitio, solo lo sabe alguien del salón. Y nadie del salón se enteró — sin pending_actions,
    // sin Telegram, sin marca en la ficha. El prompt de Sante PROHIBÍA escalar por esto
    // («solo escala en los N casos»), mientras que el de San Remo lleva la instrucción
    // contraria desde siempre. Es el caso 7 nuevo.
    //
    // Se afirma el ESTADO (la escalada ocurrió de verdad), no la redacción: es la lección de
    // los escenarios 3 y 15. La prosa solo va en la nota, para poder leer el rojo.
    await escenario('Pregunta un dato que no tenemos ("¿cómo se llama la otra chica?")', { familia: 'A', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'who was the other lady that washed my hair last time? I want to name her in my review');
        if (r.vacio) return rec('SILENCIO');

        const r2 = await turno(c, 'yes please');
        if (r2.vacio) return rec('SILENCIO', 'se calló al confirmar');

        const ficha = await db.findByPhone(ORG, c.phone.replace(/\D/g, ''));
        const escalado = !!ficha?.escalation_reason || ficha?.bot_mode === 'manual'
            || bot._internals.getSession(ORG, c.phone)?.botActivo === false;
        if (!escalado) {
            return rec('DEGRADADO',
                `no escaló · T2:"${r.txt.slice(0, 45)}" → T3:"${r2.txt.slice(0, 45)}"`);
        }
        rec('OK', `escalado (${ficha?.escalation_reason || 'bot_mode manual'})`);
    });

    await escenario('Fecha imposible ("el 31 de febrero")', { familia: 'A', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'un corte de mujer');
        const r = await turno(c, 'el 31 de febrero');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    await escenario('Hora concreta ya ocupada', { familia: 'A', idioma: 'es' }, async (c, rec) => {
        // Agenda con TODO libre salvo 16:00–17:00 dentro de 3 días.
        restore(); restore = stubAgenda({
            stylists,
            appointments: (_o, stylistId, from) => {
                const d = addDays(String(from).slice(0, 10), 3);
                return [{ id: 'occ', stylist_id: stylistId, status: 'confirmed', service: 'x',
                    starts_at: `${d}T14:00:00.000Z`, ends_at: `${d}T15:00:00.000Z` }];
            },
        });
        await turno(c, 'hola soy Pili');
        await turno(c, 'un corte de mujer');
        // El corte tiene sub-flujo (secado / peinado Dyson): hay que atravesarlo o el motor
        // nunca se consulta. Día primero y hora después, porque una hora suelta sin fecha
        // deja al bot preguntando el día y nunca se evalúa el choque con el hueco ocupado.
        await turno(c, 'con secado');
        await turno(c, 'nada más, solo eso');
        await turno(c, 'el viernes');
        const r = await turno(c, 'a las 16:00');
        restore(); restore = stubAgenda({ stylists });
        if (r.vacio) return rec('SILENCIO');
        // Aceptable: ofrecer horas concretas alternativas, o decir explícitamente que esa
        // hora está cogida. Inaceptable: un genérico sin lista, que deja a la clienta sin
        // saber qué pedir (es el agujero de salonRetryMsg, bot.js:939).
        const horas = (r.txt.match(/\b\d{1,2}:\d{2}\b/g) || []).length;
        const loDice = /ocupad|cogid|no (est[aá]|queda) (libre|disponible)|no tengo (esa|las 16)/i.test(r.txt);
        if (horas > 0) rec('OK', `${horas} horas concretas ofrecidas`);
        else if (loDice) rec('OK', 'dice que esa hora está ocupada');
        else rec('DEGRADADO', `sin horas ni explicación: "${r.txt.slice(0, 70)}"`);
    });

    // ── 13-15 · El caso Eva y la agenda llena ────────────────────────────────────────
    // CRITERIO DE ACEPTACIÓN DE LA FASE 2.2. Con la agenda literalmente llena el bot debe
    // decir que está completo, nunca anunciar una avería. Se conducen varios turnos —
    // rechazando upsells — porque el motor de huecos no se consulta hasta tener servicio
    // resuelto, y se mira TODA la conversación, no solo el último mensaje.
    await escenario('AGENDA LLENA → ¿"completo" o "problema técnico"?', { familia: 'A', idioma: 'es' }, async (c, rec) => {
        restore(); restore = stubAgenda({ stylists, appointments: AGENDA_LLENA });
        await turno(c, 'hola soy Eva');
        await turno(c, 'quiero un corte de mujer');
        // El motor no se consulta hasta tener servicio resuelto y fecha; el bot puede
        // intercalar upsells. Se insiste hasta que responda sobre disponibilidad o se
        // agoten los turnos, para no clasificar un "aún estoy preguntando" como veredicto.
        const cierre = /complet|lleno|sin hueco|no (me )?queda|no tengo (hueco|disponib)|todo ocupado|problema t[eé]cnico/i;
        for (const t of ['con secado', 'nada más, solo eso', 'el más cercano que tengas', 'el sábado', '¿tienes hueco o no?']) {
            const r = await turno(c, t);
            if (cierre.test(r.txt)) break;
        }
        const todo = c.fullText();
        restore(); restore = stubAgenda({ stylists });
        if (!todo.trim()) return rec('SILENCIO');
        if (/problema t[eé]cnico|huecos cargados|pasar tu solicitud/i.test(todo)) {
            rec('DEGRADADO', 'anuncia AVERÍA con la agenda simplemente llena ← criterio Fase 2.2');
        } else if (/complet|lleno|sin hueco|no (me )?queda|no tengo (hueco|disponib)|todo ocupado/i.test(todo)) {
            rec('OK', 'comunica que está completo');
        } else {
            rec('DEGRADADO', c.lastText().slice(0, 90));
        }
    });

    // Este check tampoco mira cómo redacta el modelo — misma corrección que se le hizo al
    // escenario 3, y por el mismo motivo. Exigía una hora concreta (`\d{1,2}:\d{2}`) en la
    // respuesta y degradaba ~1 de cada 3 corridas con el bot haciendo lo correcto: el modelo
    // propone a veces el DÍA primero ("mañana viernes, ¿te va bien?") con los huecos ya
    // cargados en la sesión. Eso es conducta buena y salía en rojo. Y al revés: la expresión
    // casaba cualquier "10:00" del texto, incluida una hora que el modelo se inventara sin
    // haber consultado la agenda — que es EXACTAMENTE el fallo de Eva, contado con otras
    // palabras.
    //
    // Lo que se afirma es el ESTADO: que el motor de huecos se consultó de verdad y trajo
    // huecos reales para el servicio que la clienta pidió. `availableSlots` sale de
    // `loadAvailableSlots` y no puede fabricarlo la prosa del modelo.
    //
    // Se mira el MÁXIMO visto a lo largo de la conversación, no el estado final: reservar o
    // reiniciar el flujo vacía `availableSlots`, y llegar a proponer huecos y luego pasar de
    // turno no puede leerse como no haberlos tenido nunca.
    await escenario('REPRO sesión real de Eva (27/07)', { familia: 'control', idioma: 'es' }, async (c, rec) => {
        const sesion = () => bot._internals.getSession(ORG, c.phone) || {};
        let maxHuecos = 0, servicio = null, causaCero = null, dbError = false;
        const observa = () => {
            const s = sesion();
            maxHuecos = Math.max(maxHuecos, (s.availableSlots || []).length);
            if (s.selectedService) servicio = s.selectedService;
            if (s.slotsCausaCero) causaCero = s.slotsCausaCero;
            if (s.slotsDbError) dbError = true;
        };

        for (const t of ['Hola', 'Quiero reservar cita', 'No se exactamente lo que quiero',
            'Quiero hacerme mechas', 'Clasicas', 'Cabeza completa']) {
            await turno(c, t); observa();
        }
        let r = await turno(c, 'El mas cercano');
        observa();
        if (r.vacio) return rec('SILENCIO');

        // Si en vez de horas contesta con el día o pide confirmación, se le sigue la
        // conversación en vez de darlo por fallido: lo que se busca es si LLEGA a la agenda.
        for (const t of ['Sí, me va bien', 'El primero que tengas']) {
            if (maxHuecos > 0 || /problema t[eé]cnico/i.test(c.fullText())) break;
            r = await turno(c, t); observa();
            if (r.vacio) return rec('SILENCIO', 'se calló a mitad de la propuesta');
        }

        // El fallo original de Eva, y sigue midiéndose sobre el TEXTO a propósito: aquí las
        // palabras SON el daño — la clienta lee una avería que no existe.
        if (/problema t[eé]cnico|huecos cargados|pasar tu solicitud/i.test(c.fullText())) {
            return rec('DEGRADADO', 'reproduce el fallo original: anuncia avería');
        }
        if (dbError) return rec('DEGRADADO', 'la lectura de la agenda falló (slotsDbError)');
        if (maxHuecos > 0) {
            return rec('OK', `${maxHuecos} huecos reales cargados${servicio ? ` · ${servicio.nombre}` : ''}`);
        }
        // Cero huecos: la nota tiene que decir POR QUÉ, o el rojo no se puede leer.
        if (!servicio) {
            return rec('DEGRADADO', `el servicio no aterrizó en la sesión: "${r.txt.slice(0, 60)}"`);
        }
        if (causaCero) {
            return rec('DEGRADADO', `motor consultado y 0 huecos (${causaCero}) con la agenda sintética 10-19`);
        }
        rec('DEGRADADO', `nunca llegó a consultar la agenda: "${r.txt.slice(0, 70)}"`);
    });

    // El caso del 02/08/2026: la clienta abre preguntando por un servicio (no "quiero cita"),
    // el bot nunca le pregunta el nombre, y acaba escribiendo la cita con full_name = null.
    //
    // ⚠️ QUÉ DEMUESTRA ESTE ESCENARIO Y QUÉ NO. Medido el 04/08/2026, cuatro ejecuciones:
    // con la puerta y sin ella el resultado es el MISMO (verde). Sin la puerta, el LLM pide
    // el nombre por su cuenta en este camino, así que un escenario conducido por el modelo
    // no puede demostrar la puerta: verde aquí significa "o la puerta funciona, o el modelo
    // preguntó igualmente", y las dos cosas no se distinguen desde fuera.
    //
    // La prueba de la puerta es determinista y está en tests/nombre-antes-de-reservar.test.js.
    // NO conviertas esto en la red de la puerta ni te fíes de su verde para tocarla.
    //
    // Lo que sí aporta, y por lo que se queda: es un MUESTREO adversarial del fallo real.
    // Clasifica contra `appointments` (ver citasSinNombre), no contra el texto de la
    // respuesta, así que cuando el modelo sí se salta el nombre lo caza siempre — se anuncie
    // la cita como se anuncie. Nunca da rojo falso: con la puerta puesta no se puede escribir
    // una fila sin nombre, así que un BUG aquí es un BUG de verdad.
    await escenario('Abre por servicio, sin dar el nombre → lo pide antes de reservar', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'Haces alisado?');
        await turno(c, 'Largo');
        await turno(c, 'La semana que viene');
        // NADA de "por la tarde": el alisado vegano dura 300 min y con la agenda sintética
        // (10-19) no cabe ninguno empezando por la tarde → agenda_llena y el escenario se
        // quedaba a dos turnos de la puerta, marcando DEGRADADO con y sin ella.
        let propuesta = await turno(c, 'El lunes');
        let horas = propuesta.txt.match(/\b\d{1,2}:\d{2}\b/g) || [];
        if (!horas.length) {
            propuesta = await turno(c, '¿A qué horas tienes?');
            horas = propuesta.txt.match(/\b\d{1,2}:\d{2}\b/g) || [];
        }
        if (!horas.length) return rec('DEGRADADO', 'no llegó a proponer huecos: ' + propuesta.txt.slice(0, 80));

        // El camino hasta la reserva lo decide el LLM y no siempre es el mismo: unas veces
        // reserva al dar la hora, otras pide aprobación antes ("¿te va bien el lunes a las
        // 10:00?"). Sin contestar a eso, el escenario se quedaba a un turno de la reserva y
        // clasificaba DEGRADADO — con y sin la puerta, o sea sin valor como red.
        // Bucle acotado: se responde "sí" mientras el bot siga pidiendo aprobación.
        let r = await turno(c, horas[0]);
        let pidioNombre = false;
        for (let i = 0; i < 3; i++) {
            if (r.vacio) return rec('SILENCIO');
            if (/nombre|llamas|c[oó]mo te (llamas|dices)|name|имя|ім'я/i.test(r.txt)) { pidioNombre = true; break; }
            if (/¿|\?/.test(r.txt)) { r = await turno(c, 'Sí'); continue; }
            break;
        }

        // El veredicto lo da la BD, no el texto: ¿quedó escrita una cita a nombre de nadie?
        const huerfanas = await citasSinNombre([c.phone]);
        if (huerfanas.length) {
            return rec('BUG', `cita escrita sin nombre: ${huerfanas[0].service} ${String(huerfanas[0].starts_at).slice(0, 16)}`);
        }
        if (pidioNombre) return rec('OK', 'pide el nombre y no ha escrito la cita');
        rec('DEGRADADO', 'ni pidió el nombre ni llegó a reservar: ' + r.txt.slice(0, 80));
    });

    await escenario('Ráfaga: 2 mensajes separados 7 s (fuera del buffer)', { familia: 'E', idioma: 'es' }, async (c, rec) => {
        const msgs = await c.sendBurst(['Quiero reservar cita', 'Quiero otra cita'], { gapMs: 7000 });
        if (msgs.length === 0) return rec('SILENCIO');
        const normed = msgs.map(norm).filter(m => m.length > 20);
        const dup = normed.length > 1 && new Set(normed).size < normed.length;
        rec(dup ? 'BUCLE' : 'OK', `${msgs.length} respuestas${dup ? ' (pregunta duplicada)' : ''}`);
    });

    // ── 16-18 · Input inesperado ─────────────────────────────────────────────────────
    await escenario('Solo emoji', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, '💇‍♀️💅');
        rec(r.vacio ? 'SILENCIO' : (r.generico ? 'DEGRADADO' : 'OK'), r.txt.slice(0, 80));
    });

    await escenario('Mensaje muy largo (800 chars)', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        const largo = 'quiero cambiar de look completamente y no sé por dónde empezar, ' .repeat(13);
        const r = await turno(c, largo.slice(0, 800));
        rec(r.vacio ? 'SILENCIO' : (r.generico ? 'DEGRADADO' : 'OK'), r.txt.slice(0, 80));
    });

    await escenario('Ruso (idioma no español)', { familia: 'D', idioma: 'ru' }, async (c, rec) => {
        const r = await turno(c, 'Здравствуйте, хочу записаться на стрижку');
        if (r.vacio) return rec('SILENCIO');
        rec(/[а-яё]/i.test(r.txt) ? 'OK' : 'DEGRADADO', 'responde en ' + (/[а-яё]/i.test(r.txt) ? 'ruso' : 'otro idioma'));
    });

    await escenario('Mensaje sin relación ("cuánto cuesta un piso")', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'cuanto cuesta alquilar un piso en alicante');
        rec(r.vacio ? 'SILENCIO' : (r.generico ? 'DEGRADADO' : 'OK'), r.txt.slice(0, 80));
    });

    // ─── 24 · «Somos dos» (Mariola Mira Lopez, 12/08/2026) ────────────────────────────
    // Pidió cita «para mí y una amiga», lo repitió tres veces, y el bot lo leyó como DOS
    // SERVICIOS para una sola persona hasta preguntarle «¿cuál queréis primero?».
    //
    // Se afirma el ESTADO, y aquí eso vale doble: el gate es determinista y pre-LLM, así que
    // lo que este escenario prueba de verdad —y que ningún test unitario puede probar— es
    // que está CABLEADO dentro del handleIncomingMessage real, no solo que la función existe.
    await escenario('Cita para dos personas ("para mí y una amiga")', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'quiero saber si teneis citas disponibles para mi y una amiga');
        if (r.vacio) return rec('SILENCIO', 'se calló al decir que son dos');
        const s = bot._internals.getSession(ORG, c.phone) || {};
        if (!s.variasPersonas) return rec('DEGRADADO', `no marcó variasPersonas · "${r.txt.slice(0, 60)}"`);
        if (!s.pendingEscalation) return rec('DEGRADADO', 'marcó las dos personas pero no ofreció una persona');
        rec('OK', `variasPersonas + traspaso ofrecido · "${r.txt.slice(0, 55)}"`);
    });

    // ─── 25 · El precio que dice la clienta ───────────────────────────────────────────
    // «El masaje capilar el de 60 euros» → «Perfecto, el Spa Hair Detox de 60 minutos» (su
    // cifra, con otra unidad) y un turno después «cuesta 115€», sin decirle nunca que a 60 €
    // no hay ningún masaje.
    //
    // EXCEPCIÓN DELIBERADA: este check mide el TEXTO, igual que el de avería. No es una
    // medida de redacción — es de qué NÚMEROS salen. Si el mensaje afirma un precio, tiene
    // que aparecer también el que ella dijo; si no, la clienta se está llevando una cifra
    // que no es la suya sin que nadie se lo señale, que es exactamente el daño. La prosa que
    // envuelva esos números da igual y no se mira.
    //
    // ES UN VIGÍA, NO UNA PRUEBA, y por eso clasifica DEGRADADO y no BUG. Medido el
    // 13/08/2026: con la red de precio APAGADA este escenario salió igualmente en verde
    // —el modelo nombró los 60 € él solo esa corrida—, así que no cumple la regla del BUG
    // («tiene que fallar SIN el arreglo y pasar CON él»). El invariante que mide es real y
    // vale la pena vigilarlo entre corridas, pero quien PRUEBA la red es
    // tests/precio-sin-respaldo.test.js, que es determinista y sí se cae con sus dos
    // mutaciones. Aquí el fallo de Mariola era intermitente, y un vigía intermitente no se
    // puede disfrazar de demostración.
    await escenario('Precio que la clienta dice y no existe ("el de 60 euros")', { familia: 'C', idioma: 'es' }, async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'El masaje capilar el de 60 euros');
        if (r.vacio) return rec('SILENCIO', 'se calló al mencionar el precio');
        const dichos = helpers.extractPrecioMencionado(r.txt);
        if (dichos.length && !dichos.includes(60)) {
            return rec('DEGRADADO', `afirma ${dichos.join('/')} € y no menciona los 60 € que pidió · "${r.txt.slice(0, 70)}"`);
        }
        rec('OK', dichos.length ? `nombra los 60 € (${dichos.join('/')})` : 'no afirma ningún precio');
    });

    restore();

    // ─── Barrido final: ninguna cita a nombre de nadie ────────────────────────────────
    // Aquí está la probabilidad de cazar el fallo, no en el escenario 16: cualquiera de los
    // ~19 escenarios puede acabar reservando, y basta con que el modelo se salte el nombre
    // UNA vez en toda la tirada. Es una comprobación contra la BD, así que no depende de
    // cómo redacte el LLM y no puede dar rojo falso con la puerta puesta.
    const huerfanas = await citasSinNombre(telefonosUsados);
    for (const h of huerfanas) {
        results.push({
            n: '—', nombre: 'BARRIDO · cita escrita sin nombre', estado: 'BUG',
            nota: `${h.telefono} · ${h.service} ${String(h.starts_at).slice(0, 16)}`,
        });
        console.log(`\n  ${ICON.BUG} BUG — cita sin nombre: ${h.telefono} · ${h.service}`);
    }

    // ─── Barrido final: ningún contacto de prueba se queda en la base ─────────────────
    // El cleanup por escenario NO basta, y no es que esté mal escrito: es una carrera. Corre en
    // el `finally`, pero `saveMessage` es fire-and-forget y el turno sigue vivo detrás, así que
    // una escritura en vuelo RESUCITA el contacto justo después de borrarlo. Medido el
    // 05/08/2026: en dos corridas seguidas sobrevivió el mismo número, el del escenario 17 —el
    // de la ráfaga, que por definición deja trabajo fuera de la ventana del buffer—.
    //
    // Por eso este barrido va por PREFIJO y no por la lista de teléfonos usados: el problema no
    // es CUÁLES, es CUÁNDO. Barrer por lista con el mismo `await` volvería a llegar pronto.
    // Y por eso hay un margen de asentamiento antes: se le da tiempo a lo que quede en vuelo a
    // aterrizar, para borrarlo después en vez de correr contra ello otra vez.
    //
    // Lo que encuentre se IMPRIME. Un barrido silencioso convertiría una fuga permanente en una
    // limpieza invisible, y nadie volvería a enterarse de que la carrera existe.
    await sleep(ASENTAMIENTO_MS);
    const residuos = await barrerContactosDePrueba();
    if (residuos.length) {
        console.log(`\n  🧹 ${residuos.length} contacto(s) de prueba borrados en el barrido final: ${residuos.join(', ')}`);
        console.log('     (los dejó una escritura en vuelo tras el cleanup de su escenario)');
    }

    // ─── Resumen ──────────────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(78));
    console.log('RESUMEN NIVEL B');
    const tally = { OK: 0, DEGRADADO: 0, SILENCIO: 0, BUCLE: 0, ERROR: 0, BUG: 0 };
    for (const r of results) tally[r.estado]++;
    for (const r of results) {
        // La constante compartida, no una copia: la copia se quedó sin BUG y el resumen
        // imprimía "undefined" justo en la línea del único fallo real.
        const icon = ICON[r.estado];
        console.log(`  ${icon} ${String(r.n).padStart(2)}. ${r.nombre.padEnd(46)} ${r.nota.slice(0, 60)}`);
    }
    // Con 25 escenarios la lista de arriba aún se lee; con ~100 lo que se busca es DÓNDE
    // se concentra el rojo — por eso las vistas agrupadas, que es para lo que existen las
    // etiquetas de familia e idioma.
    const grupos = resumenAgrupado(results);
    if (results.some(r => r.familia)) {
        console.log('─'.repeat(78));
        console.log('POR FAMILIA (A afirma-sin-respaldo · B red-ancha · C dato-sin-sitio · D idioma · E contexto-no-visto):');
        for (const l of grupos.porFamilia) console.log(l);
        console.log('POR IDIOMA (el de la clienta en el escenario):');
        for (const l of grupos.porIdioma) console.log(l);
    }
    console.log('─'.repeat(78));
    console.log(`OK ${tally.OK} · DEGRADADO ${tally.DEGRADADO} · SILENCIO ${tally.SILENCIO} · BUCLE ${tally.BUCLE} · ERROR ${tally.ERROR} · BUG ${tally.BUG}`);
    console.log('═'.repeat(78) + '\n');
    if (tally.SILENCIO || tally.ERROR || tally.BUG) process.exitCode = 1;
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
