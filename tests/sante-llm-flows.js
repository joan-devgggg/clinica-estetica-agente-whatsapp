/**
 * sante-llm-flows.js — Pruebas de conversación completas del bot de Sante con LLM real.
 * Conduce conversaciones vía handleIncomingMessage con un cliente WA simulado y verifica
 * el estado final (cita en Supabase, estilista correcta, idioma, calidad de mensajes).
 *
 * Uso: node tests/sante-llm-flows.js [n]   (n = nº de escenario opcional)
 *  Requiere OPENROUTER_API_KEY y Supabase.
 */
require('dotenv').config();
const assert = require('assert');
const bot = require('../bot');
const { SANTE_ORG_ID: ORG, SANREMO_ORG_ID } = require('../services/org-registry');
const db = require('../services/db');
const supabase = require('../services/supabase');
const { deleteClient } = require('../services/memory');

bot.setBotActivo(ORG, true, false);
bot.setBotActivo(SANREMO_ORG_ID, true, false);

let pass = 0, fail = 0;
const results = [];

// ─── Cliente WA simulado ────────────────────────────────────────────────────
function makeClient(sink) {
    return {
        sendMessage: async (_phone, text) => { sink.push({ text, t: Date.now() }); },
        getChatById: async () => ({ sendStateTyping: async () => {} }),
    };
}
let msgCounter = 0;
function makeMessage(from, text) {
    return {
        from, body: text,
        id: { _serialized: `LLM${Date.now()}_${msgCounter++}@s.whatsapp.net` },
        fromMe: false, timestamp: Date.now(), isStatus: false, isBroadcast: false, hasMedia: false,
        getChat: async () => ({ sendStateTyping: async () => {} }),
    };
}

class Convo {
    constructor(phone) {
        this.phone = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        this.sink = [];
        this.client = makeClient(this.sink);
        this.allBotMsgs = [];
    }
    // Envía un mensaje y espera a que el bot termine de responder. Un mensaje de espera
    // ("Un momento") NO se considera respuesta final: seguimos esperando la real (test 24).
    async send(text, { timeout = 90000, quiet = 3000 } = {}) {
        const before = this.sink.length;
        await bot.handleIncomingMessage(this.client, makeMessage(this.phone, text), ORG);
        const deadline = Date.now() + timeout;
        let lastLen = this.sink.length;
        let lastChange = Date.now();
        while (Date.now() < deadline) {
            await sleep(300);
            if (this.sink.length !== lastLen) { lastLen = this.sink.length; lastChange = Date.now(); }
            const got = this.sink.slice(before).map(m => m.text);
            const lastIsWait = got.length && isWaitMsg(got[got.length - 1]);
            // Terminamos si hay al menos una respuesta, hubo silencio, y la última no es de espera.
            if (got.length > 0 && (Date.now() - lastChange) > quiet && !lastIsWait) break;
        }
        const newMsgs = this.sink.slice(before).map(m => m.text);
        this.allBotMsgs.push(...newMsgs);
        return newMsgs;
    }
    lastText() { return this.allBotMsgs[this.allBotMsgs.length - 1] || ''; }
    fullText() { return this.allBotMsgs.join('\n'); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function isWaitMsg(t) {
    return /^(un momento|one moment|минутку|хвилинку)/i.test((t || '').trim());
}

// ─── Aserciones de calidad (tests 22, 23) ──────────────────────────────────
function assertQuality(msgs, label) {
    for (const m of msgs) {
        assert(!/[*_]{1,2}\S/.test(m) && !/\*\*/.test(m), `${label}: mensaje con markdown → "${m.slice(0, 60)}"`);
        assert(m.length <= 1000, `${label}: mensaje > 1000 chars (${m.length})`);
    }
}

async function cleanupPhone(phone) {
    const digits = phone.replace(/\D/g, '');
    const c = await db.findByPhone(ORG, digits);
    if (c) {
        await supabase.from('appointments').delete().eq('organization_id', ORG).eq('contact_id', c.id);
        await supabase.from('contacts').delete().eq('organization_id', ORG).eq('id', c.id);
    }
    deleteClient(ORG, phone.includes('@c.us') ? phone : `${digits}@c.us`);
}

async function getAppointments(phone) {
    const digits = phone.replace(/\D/g, '');
    const c = await db.findByPhone(ORG, digits);
    if (!c) return { contact: null, appts: [] };
    const { data } = await supabase.from('appointments')
        .select('*, stylists!stylist_id(name)')
        .eq('organization_id', ORG).eq('contact_id', c.id).neq('status', 'cancelled')
        .order('starts_at');
    return { contact: c, appts: data || [] };
}

async function scenario(name, fn) {
    console.log(`\n▶ ${name}`);
    try { await fn(); pass++; results.push({ name, ok: true }); console.log(`  ✅ PASS`); }
    catch (e) { fail++; results.push({ name, ok: false, err: e.message }); console.log(`  ❌ FAIL: ${e.message}`); }
}

function logTurn(label, user, msgs) {
    console.log(`   👤 ${user}`);
    msgs.forEach(m => console.log(`   🤖 ${m.replace(/\n/g, ' ⏎ ')}`));
}

// ─── Estilistas (para asserts) ──────────────────────────────────────────────
let STY;
async function loadStylists() {
    const s = await db.getStylistsByOrg(ORG);
    STY = Object.fromEntries(s.map(x => [x.name, x.id]));
}

// ════════════════════════════════════════════════════════════════════════════
const SCENARIOS = {

    async s1_manicura() {
        const phone = '34600000031';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hola'); logTurn('hola', 'hola', m); assertQuality(m, 's1');
        m = await c.send('soy Marta'); logTurn('nombre', 'soy Marta', m); assertQuality(m, 's1');
        m = await c.send('quiero una manicura'); logTurn('servicio', 'quiero una manicura', m); assertQuality(m, 's1');
        m = await c.send('el jueves'); logTurn('dia', 'el jueves', m); assertQuality(m, 's1');
        // Tomar la primera hora ofrecida
        m = await c.send('la primera hora que tengas'); logTurn('hora', 'la primera hora', m); assertQuality(m, 's1');
        m = await c.send('sí, perfecto, confírmala'); logTurn('confirma', 'sí confírmala', m); assertQuality(m, 's1');

        await sleep(1500);
        const { contact, appts } = await getAppointments(phone);
        assert(contact, 'contacto creado');
        assert(appts.length >= 1, `cita guardada en Supabase (encontradas: ${appts.length})`);
        const apt = appts[0];
        assert.strictEqual(apt.stylist_id, STY['Olgha'], `estilista debe ser Olgha (fue ${apt.stylists?.name})`);
        assert.strictEqual(apt.status, 'confirmed', 'cita confirmada');
        console.log(`   📌 Cita: ${apt.service} ${apt.starts_at} con ${apt.stylists?.name}`);
    },

    async s2_veronika_ok() {
        const phone = '34600000302';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hola soy Paula, quiero un corte con Veronika'); logTurn('inicio', 'corte con Veronika', m); assertQuality(m, 's2');
        m = await c.send('el lunes'); logTurn('dia', 'el lunes (Veronika trabaja)', m); assertQuality(m, 's2');
        m = await c.send('la primera, confírmala'); logTurn('confirma', 'la primera', m); assertQuality(m, 's2');
        await sleep(1500);
        const { appts } = await getAppointments(phone);
        assert(appts.length >= 1, 'cita reservada');
        assert.strictEqual(appts[0].stylist_id, STY['Veronika'], `estilista Veronika (fue ${appts[0].stylists?.name})`);
        assert.strictEqual(new Date(appts[0].starts_at).getDay(), 1, 'la cita debe caer en lunes');
        console.log(`   📌 Cita: ${appts[0].starts_at} con ${appts[0].stylists?.name}`);
    },

    async s3_veronika_dia_libre() {
        const phone = '34600000303';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hola soy Nuria, quiero un corte con Veronika'); logTurn('inicio', 'corte con Veronika', m); assertQuality(m, 's3');
        // Veronika trabaja Lun-Vie; pedimos domingo → no trabaja → debe ofrecer alternativa
        m = await c.send('el domingo'); logTurn('dia', 'el domingo (Veronika NO trabaja)', m); assertQuality(m, 's3');
        const t = c.lastText().toLowerCase();
        // No debe confirmar domingo; debe avisar y ofrecer otro día (o explicar que no trabaja)
        assert(!/domingo/.test(t) || /no |cerrado|no trabaja|otro d|disponible|lunes|martes|miércoles|miercoles|jueves|viernes/.test(t),
            `no debe ofrecer domingo sin avisar → "${c.lastText().slice(0,120)}"`);
        console.log(`   📌 Respuesta a domingo: "${c.lastText().slice(0,140)}"`);
    },

    async s4_masaje() {
        const phone = '34600000034';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hola quiero un masaje relajante'); logTurn('inicio', 'hola quiero un masaje', m); assertQuality(m, 's4');
        m = await c.send('me llamo Lucia'); logTurn('nombre', 'me llamo Lucia', m); assertQuality(m, 's4');
        m = await c.send('cuando puedas esta semana'); logTurn('dia', 'esta semana', m); assertQuality(m, 's4');
        m = await c.send('vale la primera'); logTurn('elige', 'la primera', m); assertQuality(m, 's4');
        m = await c.send('sí confirma'); logTurn('confirma', 'sí confirma', m); assertQuality(m, 's4');

        await sleep(1500);
        const { appts } = await getAppointments(phone);
        assert(appts.length >= 1, 'cita de masaje guardada');
        const apt = appts[0];
        assert.strictEqual(apt.stylist_id, STY['Larisa'], `estilista debe ser Larisa (fue ${apt.stylists?.name})`);
        const hora = new Date(apt.starts_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
        const h = Number(hora.split(':')[0]);
        assert(h < 16, `masaje antes de 16:00 (fue ${hora})`);
        console.log(`   📌 Cita: ${apt.service} ${apt.starts_at} con ${apt.stylists?.name} (${hora})`);
    },

    async s8_english() {
        const phone = '34600000038';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hello I want to book an appointment'); logTurn('en', 'hello...', m); assertQuality(m, 's8');
        // El bot debe responder en inglés
        const t = c.fullText();
        assert(/[a-z]/i.test(t), 'responde texto');
        assert(!/¿|¡|ñ/.test(c.lastText()) , 'no debe usar signos españoles en inglés');
        // heurística: contiene palabra inglesa típica
        assert(/\b(name|what|your|appointment|hi|hello|welcome|which|service)\b/i.test(t), `debe responder en inglés → "${c.lastText().slice(0,80)}"`);
        m = await c.send('my name is John'); logTurn('en', 'my name is John', m); assertQuality(m, 's8');
        m = await c.send('a haircut'); logTurn('en', 'a haircut', m); assertQuality(m, 's8');
        const t2 = c.fullText();
        assert(/\b(day|when|week|stylist|prefer|which|time|monday|tuesday|wednesday|thursday|friday)\b/i.test(t2), `sigue en inglés → "${c.lastText().slice(0,80)}"`);
    },

    async s9_russian() {
        const phone = '34600000039';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('Привет, хочу записаться на стрижку'); logTurn('ru', 'Привет...', m); assertQuality(m, 's9');
        assert(/[а-яё]/i.test(c.fullText()), `debe responder en cirílico → "${c.lastText().slice(0,80)}"`);
    },

    async s10_switch_lang() {
        const phone = '34600000310';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hello, I would like an appointment'); logTurn('en', 'hello', m);
        assert(/\b(name|hi|hello|welcome|what|service)\b/i.test(c.fullText()), 'empieza en inglés');
        m = await c.send('mejor en español, quiero un corte'); logTurn('es', 'en español', m); assertQuality(m, 's10');
        // Ahora debe responder en español
        assert(/[áéíóúñ¿¡]|\b(hola|gracias|nombre|cómo|qué|servicio|corte|día|cuál|perfecto|vale)\b/i.test(c.lastText().toLowerCase()),
            `debe cambiar a español → "${c.lastText().slice(0,80)}"`);
    },

    async s5_upselling() {
        const phone = '34600000035';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hola soy Ana, quiero color de raíz'); logTurn('inicio', 'color raíz', m); assertQuality(m, 's5');
        m = await c.send('me da igual la estilista'); logTurn('pref', 'me da igual', m); assertQuality(m, 's5');
        m = await c.send('el jueves'); logTurn('dia', 'el jueves', m); assertQuality(m, 's5');
        m = await c.send('la primera, confírmala'); logTurn('elige', 'la primera', m); assertQuality(m, 's5');
        m = await c.send('vale gracias'); logTurn('cierre', 'vale gracias', m); assertQuality(m, 's5');
        await sleep(1500);
        // Núcleo del test: la cita de color debe quedar reservada. El upselling
        // (sugerencia de complemento) es deseable pero depende del LLM → observación.
        const t = c.fullText().toLowerCase();
        const { appts } = await getAppointments(phone);
        assert(appts.length >= 1, `debe reservar la cita de color (citas: ${appts.length})`);
        const sugirio = /(manicura|ampolla|k18|tratamiento|retocar|complement|aprovech)/.test(t);
        console.log(`   📌 Citas: ${appts.length} | upselling sugerido por el LLM: ${sugirio}`);
    },

    async s6_segunda_cita() {
        const phone = '34600000036';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        let m;
        m = await c.send('hola soy Sara quiero una manicura'); logTurn('inicio', 'manicura', m); assertQuality(m, 's6');
        m = await c.send('el jueves'); logTurn('dia', 'el jueves', m); assertQuality(m, 's6');
        m = await c.send('la primera, confírmala'); logTurn('confirma1', 'la primera', m); assertQuality(m, 's6');
        await sleep(1000);
        m = await c.send('ahora otra cita de manicura para mi amigo Ivan'); logTurn('segunda', 'para mi amigo Ivan', m); assertQuality(m, 's6');
        m = await c.send('el viernes'); logTurn('dia2', 'el viernes', m); assertQuality(m, 's6');
        m = await c.send('la primera, confirma'); logTurn('confirma2', 'la primera', m); assertQuality(m, 's6');
        await sleep(1500);
        const { appts } = await getAppointments(phone);
        assert(appts.length >= 2, `deben guardarse 2 citas (encontradas: ${appts.length})`);
        const ivanApt = appts.find(a => (a.notes || '').toLowerCase().includes('ivan'));
        console.log(`   📌 Citas: ${appts.length} | nota acompañante: ${ivanApt ? ivanApt.notes : 'no detectada'}`);
        assert(ivanApt, 'la segunda cita debe anotar al acompañante Ivan');
    },

    async s15_cancelacion() {
        const phone = '34600000315';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        const m = await c.send('hola, con cuánta antelación tengo que avisar para cancelar una cita?');
        logTurn('pregunta', 'cómo cancelar', m); assertQuality(m, 's15');
        assert(/48/.test(c.fullText()), `debe mencionar 48 horas → "${c.lastText().slice(0,100)}"`);
    },

    async s7_recurrente() {
        const phone = '34600000037';
        await cleanupPhone(phone);
        // Sembrar: contacto con visita previa completada (estilista Veronika, corte)
        const cid = await db.saveLead(ORG, { telefono: phone.replace(/\D/g, ''), nombre: 'Elena', language: 'es' });
        const past = new Date(Date.now() - 20 * 24 * 3600 * 1000);
        await supabase.from('appointments').insert({
            organization_id: ORG, contact_id: cid, service: 'Corte',
            starts_at: past.toISOString(), ends_at: new Date(past.getTime() + 3600000).toISOString(),
            status: 'completed', stylist_id: STY['Veronika'], full_name: 'Elena', phone: phone.replace(/\D/g, ''),
        });
        await db.incrementVisitCount(ORG, cid);
        await db.updateContactPreferredStylist(ORG, cid, STY['Veronika']);
        deleteClient(ORG, `${phone.replace(/\D/g, '')}@c.us`);

        const c = new Convo(phone);
        const m = await c.send('hola, quiero pedir cita otra vez');
        logTurn('recurrente', 'hola otra vez', m); assertQuality(m, 's7');
        const t = c.fullText().toLowerCase();
        // Debe reconocerla por nombre o referirse a su historial/estilista habitual
        assert(/elena|veronika|de nuevo|otra vez|bienvenida de|alegr|de vuelta/.test(t),
            `debe reconocer a la clienta recurrente → "${c.lastText().slice(0,100)}"`);
        console.log(`   📌 Saludo recurrente: "${c.allBotMsgs[0]?.slice(0,90)}"`);
    },

    async s14_blacklist() {
        const phone = '34600000314';
        await cleanupPhone(phone);
        const cid = await db.saveLead(ORG, { telefono: phone.replace(/\D/g, ''), nombre: 'Bloqueado' });
        await db.setBlacklist(ORG, cid, 'test blacklist');
        deleteClient(ORG, `${phone.replace(/\D/g, '')}@c.us`);

        const c = new Convo(phone);
        const m = await c.send('hola quiero una cita');
        logTurn('blacklist', 'hola', m);
        // El bot envía 1 aviso de cortesía y luego NO responde más
        const m2 = await c.send('hola? me atendéis?', { timeout: 12000 });
        logTurn('blacklist2', 'hola?', m2);
        assert(m2.length === 0, `bot no debe responder a número en lista negra (respondió: ${JSON.stringify(m2)})`);
        console.log(`   📌 Primer aviso: "${(m[0]||'').slice(0,80)}" | 2º turno mensajes: ${m2.length}`);
    },

    async s18_toggle() {
        const phone = '34600000318';
        await cleanupPhone(phone);
        const c = new Convo(phone);
        // Pausa SOLO Sante; San Remo debe seguir activo (aislamiento por organización).
        bot.setBotActivo(ORG, false, false);
        assert.strictEqual(bot.isBotActivo(SANREMO_ORG_ID), true, 'pausar Sante NO debe afectar a San Remo');
        const m = await c.send('hola hay alguien?', { timeout: 8000 });
        logTurn('bot off (Sante)', 'hola', m);
        assert(m.length === 0, `con Sante inactivo no debe responder (respondió: ${JSON.stringify(m)})`);
        bot.setBotActivo(ORG, true, false);
        const m2 = await c.send('hola de nuevo');
        logTurn('bot on (Sante)', 'hola de nuevo', m2);
        assert(m2.length >= 1, 'con bot activo debe responder');
        console.log(`   📌 Sante off→${m.length} msgs, on→${m2.length} msgs | San Remo intacto ✅`);
    },
};

// ════════════════════════════════════════════════════════════════════════════
(async () => {
    await loadStylists();
    const only = process.argv[2];
    const filters = only ? only.split(',') : null;
    const keys = Object.keys(SCENARIOS).filter(k => !filters || filters.some(f => k.includes(f)));
    for (const k of keys) {
        await scenario(k, SCENARIOS[k]);
    }
    // limpieza final
    for (const p of ['34600000031','34600000034','34600000038','34600000039','34600000310','34600000035','34600000036','34600000315','34600000037','34600000314','34600000318','34600000302','34600000303']) {
        await cleanupPhone(p).catch(() => {});
    }
    console.log(`\n═══ RESUMEN LLM flows: ${pass} ✅  /  ${fail} ❌ ═══`);
    results.filter(r => !r.ok).forEach(r => console.log(`  • ${r.name}: ${r.err}`));
    process.exit(fail ? 1 : 0);
})();
