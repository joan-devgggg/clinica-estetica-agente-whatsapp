/**
 * tests/reserva-web-aviso-telegram.test.js — el aviso de una reserva del enlace.
 *
 * Se stubea `node-telegram-bot-api`, NO `services/telegram`: encima corre el telegram.js de
 * verdad y el webhook.js de verdad, así que lo que se afirma es la conducta, no un doble.
 * Molde de tests/admin-alert-reintento.test.js (el fake bot) y de
 * tests/reserva-web-endpoints.test.js (el Express real por node:http). Sin red.
 *
 * LAS DOS COSAS QUE HAY QUE FIJAR, y las dos son de contrato:
 *
 *   1. UN AVISO POR RESERVA. `alertOnce` agrupa por clave y calla hasta que el asunto se
 *      resuelve —eso es para una avería que se repite—; aquí la segunda clienta del día es
 *      un hecho nuevo, y con la mecánica de alarma no se anunciaría. Lo mide el bloque de
 *      las dos reservas seguidas, que es el que se cae si alguien lo pasa a alertOnce.
 *   2. UN TELEGRAM CAÍDO NO SE LLEVA UNA CITA ESCRITA. Cuando el aviso sale, la fila ya
 *      está en `appointments`: si el fallo del aviso subiera por la pila, la clienta leería
 *      «no se ha podido reservar» sobre una cita que existe, y volvería a intentarlo.
 *
 * ── Sabotajes medidos (21/08/2026) ───────────────────────────────────────────────────────
 *   · LAS DOS REDES fuera (esperar el aviso sin catch + notifyReservaWeb sin
 *     su try/catch): la cita escrita sale como «no se ha podido reservar» ........ 3 rojos
 *   · solo esperar el aviso con `await` (la clienta paga la latencia de Telegram) . 1 rojo
 *   · solo quitarle el try/catch a notifyReservaWeb .............................. 1 rojo
 *   · mandar el aviso ANTES del claim (se anuncian citas que no se escriben) ..... 3 rojos
 *
 * Y una cosa que este fichero MIDIÓ y conviene no olvidar: un 403 de Telegram NO se
 * propaga solo —`notifyOrgAdmin` ya se lo traga y devuelve false—, así que probar únicamente
 * «Telegram rechaza» no mediría ninguna de las dos redes. Lo que sí sube es un fallo al
 * CONSTRUIR el mensaje, y por eso hay un bloque que lo provoca con lo único de todo esto que
 * escribe un desconocido: el nombre.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RESERVA_WEB_TOKEN = 'token-de-prueba-32-caracteres-xx';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';

const assert = require('assert');
const http = require('http');

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SLUG = 'sante-healthy-hair-salon';
const TOKEN = process.env.RESERVA_WEB_TOKEN;
const IRINA = 'c3d4e5f6-0000-0000-0000-000000000101';
const NATALIA = 'c3d4e5f6-0000-0000-0000-000000000107';

// ─── Telegram falso ──────────────────────────────────────────────────────────────────────
const enviados = [];
let responder = () => ({ message_id: 999 });
class FakeTelegramBot {
    on() {}
    async sendMessage(userId, texto, opts) {
        enviados.push({ userId, texto, opts });
        return responder();
    }
}
const tgLibPath = require.resolve('node-telegram-bot-api');
require.cache[tgLibPath] = { id: tgLibPath, filename: tgLibPath, loaded: true, exports: FakeTelegramBot };

// ─── db ──────────────────────────────────────────────────────────────────────────────────
// Se PARCHEA el módulo real (no se sustituye) porque webhook.js usa el namespace entero y
// necesita `db.ReservaWebRechazada`. Y se parchea ANTES de requerir telegram.js, que
// desestructura `getConfigValue` al cargarse: al revés capturaría la función de verdad y el
// mapa de admins saldría vacío.
const db = require('../services/db');
const calendarSante = require('../services/calendar-sante');

let ESTADO;
function reset() {
    enviados.length = 0;
    responder = () => ({ message_id: 999 });
    ESTADO = {
        config: { reservas_web_activo: true },
        citas: [],
        rechazos: [],
        // El nombre de la FILA es distinto del que se teclea: `saveLead` no pisa el nombre
        // guardado, así que el aviso tiene que decir el que la dueña verá en el panel.
        nombreEnFicha: 'Marta Ivanova',
        slots: ['10:00', '11:00'].map(hora => ({
            fecha: '2026-09-10', hora, stylistId: IRINA, stylistName: 'Irina',
            alternativas: [{ id: IRINA, name: 'Irina' }, { id: NATALIA, name: 'Natalia' }],
        })),
    };
}
reset();

db.getConfigValue = async (orgId, clave) =>
    (clave === 'telegram_admins' && orgId === SANTE) ? [12345] : null;
db.getAllConfig = async () => ESTADO.config;
db.getAgentConfig = async () => ({
    services: [{ categoria: 'Cortes', nombre: 'Mujer y secado', precio: 40, duracion: 60 }],
    business_info: { companyName: 'Sante' },
});
db.getContactoParaReservaWeb = async () => null;
db.saveLead = async () => 'contact-1';
db.saveAppointment = async (_org, contactId, opts) => {
    ESTADO.citas.push({ contactId, ...opts });
    const motivo = ESTADO.rechazos.shift();
    if (motivo) throw new db.ReservaWebRechazada(motivo);
    return {
        id: `cita-${ESTADO.citas.length}`,
        starts_at: '2026-09-10T10:00:00+02:00',
        full_name: ESTADO.nombreEnFicha,
        phone: '34600111222',
    };
};
calendarSante.getAvailableSlots = async () => {
    const out = [...ESTADO.slots];
    out.causa = null; out.requestedDayUnavailable = false;
    return out;
};

const { initSendOnlyBot, notifyReservaWeb } = require('../services/telegram');
const { app, _candadoReserva, _limitadorReservas } = require('../webhook');

function request(server, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
    const { port } = server.address();
    const datos = body === null ? null : JSON.stringify(body);
    const cabeceras = { ...headers };
    if (datos) { cabeceras['Content-Type'] = 'application/json'; cabeceras['Content-Length'] = Buffer.byteLength(datos); }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: cabeceras }, (res) => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
        });
        req.on('error', reject);
        if (datos) req.write(datos);
        req.end();
    });
}

const desde = (ip) => ({ 'X-Reserva-Token': TOKEN, 'X-Cliente-IP': ip });
const cuerpo = (extra = {}) => ({
    servicio: 'Cortes|Mujer y secado', fecha: '2026-09-10', hora: '10:00',
    nombre: 'Marta', telefono: '600111222', lang: 'es', ...extra,
});

/** El aviso viaja sin esperarse: se le da un respiro al bucle de eventos antes de mirarlo. */
const respirar = () => new Promise(r => setTimeout(r, 30));

async function test(name, fn) {
    try {
        reset(); _candadoReserva._reset(); _limitadorReservas._reset();
        await fn();
        console.log(`ok - ${name}`);
    } catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

(async () => {
    await initSendOnlyBot();
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    let n = 0;
    const ipNueva = () => `10.9.0.${++n}`;

    try {
        // ─── QUÉ DICE ────────────────────────────────────────────────────────────────────

        await test('el aviso lleva quién, qué, cuándo y con quién, sin abrir nada', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: cuerpo(),
            });
            assert.strictEqual(res.status, 200);
            await respirar();
            assert.strictEqual(enviados.length, 1, 'una reserva, un aviso');
            const t = enviados[0].texto;
            assert.ok(t.includes('Nueva cita por internet'), t);
            assert.ok(t.includes('Marta Ivanova'), 'falta QUIÉN');
            assert.ok(t.includes('34600111222'), 'falta el teléfono: es lo único accionable desde el aviso');
            assert.ok(t.includes('Corte mujer y secado'), 'falta QUÉ servicio');
            assert.ok(t.includes('Irina'), 'falta CON QUIÉN');
            assert.ok(t.includes('10:00') && t.includes('jueves') && t.includes('10 de septiembre'),
                `falta CUÁNDO: ${t}`);
        });

        await test('el nombre es el de la FICHA, no el que se tecleó', async () => {
            // `saveLead` no pisa el nombre guardado, así que la cita se apunta con el de la
            // ficha. Un aviso que dijera otro mandaría a la dueña a buscar a alguien que no
            // aparece en el panel.
            await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: cuerpo({ nombre: 'Marta' }),
            });
            await respirar();
            assert.ok(enviados[0].texto.includes('Marta Ivanova'));
        });

        await test('el «cuándo» es el MISMO que dirá el recordatorio de 24 h', async () => {
            // No hay una segunda tabla de días de la semana en este fichero: sale de
            // formatReminderWhen, que es de donde sale el recordatorio (CLAUDE.md).
            const { formatReminderWhen } = require('../services/helpers');
            await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: cuerpo(),
            });
            await respirar();
            assert.ok(enviados[0].texto.includes(formatReminderWhen('2026-09-10', '10:00', 'es')));
        });

        // ─── UNO POR RESERVA, NO UNA ALARMA AGRUPADA ─────────────────────────────────────

        await test('dos reservas seguidas son DOS avisos', async () => {
            // El bloque que se cae si esto se pasa a `alertOnce`: agruparía por clave y la
            // segunda clienta del día no se anunciaría.
            const ip = ipNueva();
            await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ip), body: cuerpo({ hora: '10:00' }),
            });
            await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ip), body: cuerpo({ hora: '11:00', nombre: 'Olga' }),
            });
            await respirar();
            assert.strictEqual(enviados.length, 2, 'la segunda reserva no se ha anunciado');
        });

        await test('un doble toque es UNA reserva y UN aviso', async () => {
            // El candado del doble envío responde lo guardado sin volver a ejecutar el
            // trabajo, así que el aviso —que vive dentro— tampoco se repite.
            const ip = ipNueva();
            const [a, b] = await Promise.all([
                request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: cuerpo() }),
                request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: cuerpo() }),
            ]);
            assert.strictEqual(a.status, 200);
            assert.strictEqual(b.status, 200);
            await respirar();
            assert.strictEqual(ESTADO.citas.length, 1, 'el candado dejó pasar dos citas');
            assert.strictEqual(enviados.length, 1, 'dos avisos por un doble toque');
        });

        await test('una reserva que NO se escribe no se anuncia', async () => {
            // Avisar antes del claim contaría citas que no existen, y la dueña buscaría en el
            // panel una clienta que nunca llegó a reservar.
            ESTADO.rechazos = ['hueco_ocupado', 'hueco_ocupado'];
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: cuerpo(),
            });
            assert.notStrictEqual(res.status, 200);
            await respirar();
            assert.strictEqual(enviados.length, 0);
        });

        // ─── UN TELEGRAM CAÍDO NO SE LLEVA UNA CITA ESCRITA ──────────────────────────────

        await test('si Telegram rechaza, la reserva sigue confirmada', async () => {
            responder = () => { throw new Error('ETELEGRAM: 403 bot was blocked by the user'); };
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: cuerpo(),
            });
            assert.strictEqual(res.status, 200, 'un aviso fallido ha tumbado una cita que ya está escrita');
            assert.strictEqual(res.body.cita.servicio, 'Corte mujer y secado');
            assert.strictEqual(ESTADO.citas.length, 1);
            await respirar();
        });

        await test('un dato imposible en el aviso tampoco tumba la cita', async () => {
            // El caso que de verdad puede propagarse. `notifyOrgAdmin` ya se traga los fallos
            // de ENVÍO —un 403 de Telegram no sube—, así que probar solo eso no mediría
            // ninguna de las dos redes. Lo que sí sube es un fallo al CONSTRUIR el mensaje, y
            // aquí se provoca con lo único de todo esto que escribe un desconocido: el
            // nombre. A esta altura la cita ya está en `appointments`.
            ESTADO.nombreEnFicha = { toString() { throw new Error('nombre imposible'); } };
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: cuerpo(),
            });
            assert.strictEqual(res.status, 200,
                'un aviso que revienta ha convertido una cita escrita en «no se ha podido reservar»');
            assert.strictEqual(ESTADO.citas.length, 1);
            await respirar();
        });

        await test('si Telegram tarda, la clienta no espera', async () => {
            // El aviso va sin `await`. Con uno, la confirmación de la clienta quedaría detrás
            // de la latencia de un servicio que no es suyo.
            responder = () => new Promise(r => setTimeout(() => r({ message_id: 1 }), 400));
            const t0 = Date.now();
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: cuerpo(),
            });
            const tardo = Date.now() - t0;
            assert.strictEqual(res.status, 200);
            assert.ok(tardo < 300, `la respuesta esperó al aviso (${tardo} ms)`);
        });

        // ─── LA FUNCIÓN, POR DENTRO ──────────────────────────────────────────────────────

        await test('notifyReservaWeb NO lanza jamás, pase lo que pase', async () => {
            // Su contrato: cuando corre, la cita ya está escrita. No puede propagar nada.
            responder = () => { throw new Error('caído'); };
            assert.strictEqual(await notifyReservaWeb(SANTE, { nombre: 'A', fecha: 'x', hora: 'y' }), false);
            assert.strictEqual(await notifyReservaWeb(SANTE, null), false);
            assert.strictEqual(await notifyReservaWeb(SANTE, { nombre: { raro: 1 }, fecha: 1, hora: [] }), false);
            assert.strictEqual(await notifyReservaWeb('org-que-no-existe', {}), false);
        });

        await test('una fecha ilegible NO calla la cita: salen fecha y hora en crudo', async () => {
            await notifyReservaWeb(SANTE, {
                nombre: 'Ana', telefono: '600', servicio: 'Corte',
                fecha: 'mañana', hora: '10:00', estilista: 'Irina',
            });
            const t = enviados.at(-1).texto;
            assert.ok(t.includes('mañana') && t.includes('10:00'),
                `una cita real se ha quedado sin cuándo: ${t}`);
        });

        await test('un nombre con < > no rompe el mensaje: va escapado', async () => {
            // parse_mode HTML: sin escapar, Telegram rechaza el mensaje ENTERO y el aviso se
            // pierde por culpa de lo que alguien tecleó en un formulario público.
            await notifyReservaWeb(SANTE, { nombre: '<b>Ana</b>', fecha: '2026-09-10', hora: '10:00' });
            const t = enviados.at(-1).texto;
            assert.ok(t.includes('&lt;b&gt;Ana&lt;/b&gt;'), t);
            assert.ok(!t.includes('<b>Ana</b>'));
        });
    } finally {
        server.close();
    }
})();
