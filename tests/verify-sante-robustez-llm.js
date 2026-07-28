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
 *
 * La agenda se sintetiza (stub de la capa db) para poder forzar escenarios imposibles de
 * reproducir con la agenda real: salón completamente lleno, estilista sin horario, etc.
 * El LLM y toda la lógica del bot son reales.
 *
 * Uso:  npm run verify:robustez:llm            (todos)
 *       npm run verify:robustez:llm -- 7       (solo el escenario 7)
 *   Requiere OPENROUTER_API_KEY + Supabase. Consume tokens y tarda varios minutos.
 */
require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const bot = require('../bot');
const db = require('../services/db');
const supabase = require('../services/supabase');
const { deleteClient } = require('../services/memory');
const { SANTE_ORG_ID: ORG } = require('../services/org-registry');
const { Convo: BaseConvo, sleep } = require('./lib/convo');

bot.setBotActivo(ORG, true, false);

class Convo extends BaseConvo {
    constructor(phone) { super(phone, ORG); }
}

// ─── Clasificación ───────────────────────────────────────────────────────────────────
const results = [];
const ICON = { OK: '✅', DEGRADADO: '⚠️ ', SILENCIO: '🔇', BUCLE: '🔁', ERROR: '💥' };

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

let seq = 0;
const nextPhone = () => `3460099${String(1000 + (seq++)).slice(-4)}`;

const only = process.argv[2] ? Number(process.argv[2]) : null;
let idx = 0;
async function escenario(nombre, fn) {
    idx++;
    const n = idx;
    if (only && only !== n) return;
    console.log(`\n▶ ${n}. ${nombre}`);
    const phone = nextPhone();
    await cleanup(phone);
    const c = new Convo(phone);

    // Cada escenario se clasifica UNA sola vez: la primera llamada gana, para que un
    // `return rec(...)` temprano no se vea pisado por la detección de bucle posterior.
    let done = false;
    const rec = (estado, nota) => {
        if (done) return;
        done = true;
        results.push({ n, nombre, estado, nota: nota || '' });
        console.log(`  ${ICON[estado]} ${estado}${nota ? ` — ${nota}` : ''}`);
    };

    try {
        await fn(c, rec, phone);
        // Un bucle solo tiene sentido si el escenario no falló ya por otra vía.
        const bucle = detectaBucle(c);
        if (bucle && !done) rec('BUCLE', bucle);
        if (!done) rec('OK');
    } catch (e) {
        // Un error de ejecución manda sobre cualquier veredicto ya emitido.
        const prev = results.findIndex(r => r.n === n);
        if (prev !== -1) results.splice(prev, 1);
        done = false;
        rec('ERROR', e.message);
    } finally {
        await cleanup(phone);
        await sleep(500);
    }
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
    await escenario('Servicio inexistente ("un piercing")', async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'quiero hacerme un piercing');
        if (r.vacio) return rec('SILENCIO');
        // Debe decir que no lo hace u ofrecer lo que sí hace, no callarse ni divagar.
        if (/no (lo )?(hacemos|ofrecemos|tenemos)|no traba|no dispon|ofrec|tenemos/i.test(r.txt)) rec('OK', 'reconduce');
        else if (r.generico) rec('DEGRADADO', r.txt.slice(0, 80));
        else rec('OK', r.txt.slice(0, 80));
    });

    await escenario('Servicio ambiguo ("algo para el pelo")', async (c, rec) => {
        await turno(c, 'buenas');
        const r = await turno(c, 'quiero algo para el pelo pero no sé qué');
        if (r.vacio) return rec('SILENCIO');
        if (r.generico) return rec('DEGRADADO', r.txt.slice(0, 80));
        rec('OK', r.txt.slice(0, 90));
    });

    await escenario('Servicio con falta de ortografía ("valayage")', async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'kiero un valayage');
        if (r.vacio) return rec('SILENCIO');
        rec(/balayage/i.test(r.txt) ? 'OK' : 'DEGRADADO', r.txt.slice(0, 90));
    });

    await escenario('Cambio de opinión en mitad del flujo', async (c, rec) => {
        await turno(c, 'hola, soy Ana');
        await turno(c, 'quiero un corte de mujer');
        const r = await turno(c, 'uy no, mejor unas mechas balayage');
        if (r.vacio) return rec('SILENCIO');
        rec(/balayage/i.test(r.txt) ? 'OK' : 'DEGRADADO', r.txt.slice(0, 90));
    });

    // ── 5-8 · Estilista ──────────────────────────────────────────────────────────────
    await escenario('Estilista mal escrita ("con Olga" → Olgha)', async (c, rec) => {
        await turno(c, 'hola soy Marta');
        await turno(c, 'quiero una manicura');
        const r = await turno(c, 'con Olga por favor');
        if (r.vacio) return rec('SILENCIO');
        // Lo correcto es confirmar Olgha o preguntar; lo malo es ignorarlo en silencio.
        if (/olgha|olga/i.test(r.txt)) rec('OK', 'menciona a la estilista');
        else rec('DEGRADADO', `ignora la petición: "${r.txt.slice(0, 80)}"`);
    });

    await escenario('Estilista inexistente ("con Carmen")', async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'quiero un corte de mujer');
        const r = await turno(c, 'con Carmen');
        if (r.vacio) return rec('SILENCIO');
        if (/no (tengo|trabaja|hay)|no est|no la|carmen/i.test(r.txt)) rec('OK', 'lo comenta');
        else rec('DEGRADADO', `no dice que Carmen no existe: "${r.txt.slice(0, 70)}"`);
    });

    await escenario('Estilista sin la skill ("mechas con Larisa")', async (c, rec) => {
        await turno(c, 'hola soy Rosa');
        const r = await turno(c, 'quiero mechas balayage con Larisa');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    await escenario('Estilista primero, servicio después (orden invertido)', async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'quiero pedir hora con Larisa');
        const r = await turno(c, 'para unas mechas');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    // ── 9-12 · Fecha y hora ──────────────────────────────────────────────────────────
    await escenario('"quiero cita hoy"', async (c, rec) => {
        await turno(c, 'hola soy Lucía');
        await turno(c, 'un corte de mujer');
        const r = await turno(c, 'quiero cita hoy si puede ser');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    await escenario('"el finde"', async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'un corte de mujer');
        const r = await turno(c, 'me viene bien el finde');
        if (r.vacio) return rec('SILENCIO');
        rec(/s[aá]bado|domingo|finde|fin de semana/i.test(r.txt) ? 'OK' : 'DEGRADADO', r.txt.slice(0, 90));
    });

    await escenario('Fecha imposible ("el 31 de febrero")', async (c, rec) => {
        await turno(c, 'hola');
        await turno(c, 'un corte de mujer');
        const r = await turno(c, 'el 31 de febrero');
        if (r.vacio) return rec('SILENCIO');
        rec(r.generico ? 'DEGRADADO' : 'OK', r.txt.slice(0, 90));
    });

    await escenario('Hora concreta ya ocupada', async (c, rec) => {
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
    await escenario('AGENDA LLENA → ¿"completo" o "problema técnico"?', async (c, rec) => {
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

    await escenario('REPRO sesión real de Eva (27/07)', async (c, rec) => {
        await turno(c, 'Hola');
        await turno(c, 'Quiero reservar cita');
        await turno(c, 'No se exactamente lo que quiero');
        await turno(c, 'Quiero hacerme mechas');
        await turno(c, 'Clasicas');
        await turno(c, 'Cabeza completa');
        const r = await turno(c, 'El mas cercano');
        if (r.vacio) return rec('SILENCIO');
        if (/problema t[eé]cnico/i.test(r.txt)) rec('DEGRADADO', 'reproduce el fallo original');
        else if ((r.txt.match(/\b\d{1,2}:\d{2}\b/g) || []).length > 0) rec('OK', 'propone huecos reales');
        else rec('DEGRADADO', r.txt.slice(0, 90));
    });

    await escenario('Ráfaga: 2 mensajes separados 7 s (fuera del buffer)', async (c, rec) => {
        const msgs = await c.sendBurst(['Quiero reservar cita', 'Quiero otra cita'], { gapMs: 7000 });
        if (msgs.length === 0) return rec('SILENCIO');
        const normed = msgs.map(norm).filter(m => m.length > 20);
        const dup = normed.length > 1 && new Set(normed).size < normed.length;
        rec(dup ? 'BUCLE' : 'OK', `${msgs.length} respuestas${dup ? ' (pregunta duplicada)' : ''}`);
    });

    // ── 16-18 · Input inesperado ─────────────────────────────────────────────────────
    await escenario('Solo emoji', async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, '💇‍♀️💅');
        rec(r.vacio ? 'SILENCIO' : (r.generico ? 'DEGRADADO' : 'OK'), r.txt.slice(0, 80));
    });

    await escenario('Mensaje muy largo (800 chars)', async (c, rec) => {
        await turno(c, 'hola');
        const largo = 'quiero cambiar de look completamente y no sé por dónde empezar, ' .repeat(13);
        const r = await turno(c, largo.slice(0, 800));
        rec(r.vacio ? 'SILENCIO' : (r.generico ? 'DEGRADADO' : 'OK'), r.txt.slice(0, 80));
    });

    await escenario('Ruso (idioma no español)', async (c, rec) => {
        const r = await turno(c, 'Здравствуйте, хочу записаться на стрижку');
        if (r.vacio) return rec('SILENCIO');
        rec(/[а-яё]/i.test(r.txt) ? 'OK' : 'DEGRADADO', 'responde en ' + (/[а-яё]/i.test(r.txt) ? 'ruso' : 'otro idioma'));
    });

    await escenario('Mensaje sin relación ("cuánto cuesta un piso")', async (c, rec) => {
        await turno(c, 'hola');
        const r = await turno(c, 'cuanto cuesta alquilar un piso en alicante');
        rec(r.vacio ? 'SILENCIO' : (r.generico ? 'DEGRADADO' : 'OK'), r.txt.slice(0, 80));
    });

    restore();

    // ─── Resumen ──────────────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(78));
    console.log('RESUMEN NIVEL B');
    const tally = { OK: 0, DEGRADADO: 0, SILENCIO: 0, BUCLE: 0, ERROR: 0 };
    for (const r of results) tally[r.estado]++;
    for (const r of results) {
        const icon = { OK: '✅', DEGRADADO: '⚠️ ', SILENCIO: '🔇', BUCLE: '🔁', ERROR: '💥' }[r.estado];
        console.log(`  ${icon} ${String(r.n).padStart(2)}. ${r.nombre.padEnd(46)} ${r.nota.slice(0, 60)}`);
    }
    console.log('─'.repeat(78));
    console.log(`OK ${tally.OK} · DEGRADADO ${tally.DEGRADADO} · SILENCIO ${tally.SILENCIO} · BUCLE ${tally.BUCLE} · ERROR ${tally.ERROR}`);
    console.log('═'.repeat(78) + '\n');
    if (tally.SILENCIO || tally.ERROR) process.exitCode = 1;
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('\n💥', e); process.exit(1); });
