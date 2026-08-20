// Integración de la ruta PUT /api/citas/:id (item 9): marcar no_show debe encadenar
// db.setBlacklist sobre el contacto. El encadenamiento vive en webhook.js (no en un trigger
// SQL), así que se ejercita la ruta real con db mockeada y sin Supabase/Telegram reales.
process.env.TZ = 'Europe/Madrid';
process.env.DASHBOARD_API_SECRET = 'test-secret';                 // activa requireApiAuth
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const http = require('http');

// Stub del módulo telegram ANTES de requerir webhook: evita cargar node-telegram-bot-api /
// arrancar el bot, y neutraliza notifyBlacklistAlert (best-effort, no debe tocar red en tests).
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyReservaWeb: async () => {}, notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

// admin-alerts GRABANDO: el aviso de "no-show sin bloquear" es la mitad del arreglo del
// 12/08/2026 —el 200 dice la verdad sobre la cita, y el aviso dice lo que NO se hizo—, así que
// hay que poder afirmarlo. Se intercepta antes de requerir webhook.js, que lo captura al cargar.
const avisos = [];
const alertsPath = require.resolve('../services/admin-alerts');
require.cache[alertsPath] = {
    id: alertsPath, filename: alertsPath, loaded: true,
    exports: {
        alertOnce: async (orgId, clave, mensaje) => { avisos.push({ orgId, clave, mensaje }); return true; },
        clearAlert: () => true,
        _resetThrottle: () => {},
    },
};

const { app } = require('../webhook');
const db = require('../services/db');

// Auth: la API deriva la org del token verificado. Mockeamos el verificador para
// que 'test-secret' equivalga a un usuario de org-sante (sin tocar Supabase real).
db.authenticateToken = async (token) => (token === 'test-secret' ? { userId: 'u1', orgId: 'org-sante' } : null);

// Mock de la capa db que usa la ruta (mismo objeto de módulo que webhook.js).
let blacklistCalls = [];
let syncCalls = [];
let updateAppointmentCalls = [];
db.updateAppointment = async (orgId, id, body) => {
    updateAppointmentCalls.push(body);
    return { id, contact_id: 'c1', status: body.estado };
};
db.findById = async () => ({ id: 'c1', nombre: 'María', telefono: '34600000000' });
db.setBlacklist = async (orgId, contactId, reason) => { blacklistCalls.push({ orgId, contactId, reason }); return true; };
// La ruta lee el estado ANTERIOR (para no contar dos veces la visita) y sincroniza la ficha
// del contacto (que es la que lee reminder.js). Sin estos dos stubs irían a Supabase real.
db.getAppointmentById = async (orgId, id) => ({ id, contact_id: 'c1', status: 'confirmed' });
db.updateLeadById = async (orgId, contactId, campos) => { syncCalls.push({ contactId, campos }); return { id: contactId }; };
db.stampBillingSnapshot = async () => ({ intentadas: 1, selladas: 1, fallidas: 0 });

function put(server, id, body) {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'PUT', path: `/api/citas/${id}`,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': 'Bearer test-secret',
                'X-Organization-Id': 'org-sante',
            },
        }, res => {
            let data = '';
            res.on('data', d => (data += d));
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function test(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        await test('9 · PUT no_show → dispara setBlacklist("No-show") en el contacto', async () => {
            blacklistCalls = [];
            const res = await put(server, 'apt-1', { estado: 'no_show' });
            assert.strictEqual(res.status, 200, 'la ruta responde 200');
            assert.strictEqual(blacklistCalls.length, 1, 'setBlacklist se llama exactamente una vez');
            assert.deepStrictEqual(blacklistCalls[0], { orgId: 'org-sante', contactId: 'c1', reason: 'No-show' });
        });

        // Hasta el 12/08/2026 setBlacklist no iba aislado: como lanza (verifica filas), un
        // fallo devolvía 500 sobre un PUT cuyo updateAppointment YA había escrito el no-show.
        // La pantalla decía "no se pudo" y el no-show estaba puesto. Mismo criterio que
        // stampBillingSnapshot: el 200 es del UPDATE, que sí ocurrió — pero el bloqueo perdido
        // no se queda en un log, porque es la mitad de lo que se pidió al marcar el no-show.
        await test('9 · si el bloqueo falla, el 200 se mantiene (la cita SÍ se guardó) y AVISA', async () => {
            const real = db.setBlacklist;
            db.setBlacklist = async () => { throw new Error('contacts: nada guardado'); };
            try {
                const res = await put(server, 'apt-1', { estado: 'no_show' });
                assert.strictEqual(res.status, 200,
                    'el UPDATE de la cita tuvo éxito: un 500 diría que no se guardó nada, y sí se guardó');
                assert.ok(avisos.some(a => /no.?show/i.test(a.clave)),
                    `el bloqueo perdido tiene que avisar; avisos: ${JSON.stringify(avisos)}`);
                const texto = avisos.map(a => a.mensaje).join(' ');
                assert.ok(/lista negra/i.test(texto), 'y decir qué es lo que NO ha pasado');
                assert.ok(/campañas|recordatorio/i.test(texto),
                    'con la consecuencia: le seguirán llegando envíos');
            } finally {
                db.setBlacklist = real;
            }
        });

        await test('9 · CONTROL: cuando el bloqueo va bien, NO se avisa de nada', async () => {
            avisos.length = 0;
            blacklistCalls = [];
            const res = await put(server, 'apt-1', { estado: 'no_show' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(blacklistCalls.length, 1, 'se bloqueó');
            assert.strictEqual(avisos.length, 0, 'y no hay aviso: sin esto el bloque de arriba no prueba nada');
        });

        await test('9 · CONTROL: PUT estado confirmed NO dispara setBlacklist', async () => {
            blacklistCalls = [];
            const res = await put(server, 'apt-1', { estado: 'confirmed' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(blacklistCalls.length, 0, 'sin no_show no hay blacklist');
        });

        // Reagendar desde el panel dejaba contacts.fecha_cita/hora_cita con los valores viejos,
        // y reminder.js lee esa tabla: el recordatorio salía con la hora antigua.
        await test('reagendar desde el panel sincroniza la ficha del contacto', async () => {
            syncCalls = [];
            // duracionMin va SIEMPRE que se mueve la cita: es la rama que recalcula ends_at
            // y desde 04/08/2026 no se rellena con un 120 por defecto (ver test de abajo).
            const res = await put(server, 'apt-1', { fecha: '2026-08-05', hora: '17:30', duracionMin: 60, estado: 'confirmed' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(syncCalls.length, 1, 'sincroniza una vez');
            assert.strictEqual(syncCalls[0].contactId, 'c1');
            assert.strictEqual(syncCalls[0].campos.fecha_cita, '2026-08-05');
            assert.strictEqual(syncCalls[0].campos.hora_cita, '17:30');
            assert.strictEqual(syncCalls[0].campos.estado_cita, 'confirmado', 'traduce status→estado de contacto');
        });

        await test('cancelar una cita también deja la ficha en cancelado', async () => {
            syncCalls = [];
            const res = await put(server, 'apt-1', { estado: 'cancelled' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(syncCalls[0]?.campos.estado_cita, 'cancelado');
        });

        await test('9 · AUTH: sin token la ruta responde 401', async () => {
            const { port } = server.address();
            const res = await new Promise((resolve, reject) => {
                const r = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/citas/apt-1',
                    headers: { 'Content-Type': 'application/json' } }, resp => {
                    resp.on('data', () => {}); resp.on('end', () => resolve({ status: resp.statusCode }));
                });
                r.on('error', reject); r.end('{}');
            });
            assert.strictEqual(res.status, 401);
        });

        // Mover una cita sin decir cuánto dura llegaba a db.updateAppointment y allí se
        // resolvía con un 120 por defecto: no creaba una cita mal medida, REDIMENSIONABA
        // una existente (un alisado de 5 h pasaba a 2 h y las otras 3 se publicaban como
        // libres). Ahora se rechaza antes, con un motivo que se lee.
        await test('mover la cita sin duración: 400 con motivo, y NO se toca la cita', async () => {
            for (const mala of [undefined, null, 0, '', 'sesenta', -30]) {
                updateAppointmentCalls = [];
                const body = { fecha: '2026-08-05', hora: '17:30', estado: 'confirmed' };
                if (mala !== undefined) body.duracionMin = mala;
                const res = await put(server, 'apt-1', body);
                assert.strictEqual(res.status, 400, `duracionMin=${JSON.stringify(mala)}`);
                assert.match(res.body.error, /[Dd]uración/, 'el motivo dice qué falta');
                assert.strictEqual(updateAppointmentCalls.length, 0, 'la cita no se toca');
            }
        });

        await test('un PUT que NO mueve la cita no necesita duración', async () => {
            // Cambiar estado o notas no recalcula ends_at, así que exigir duración ahí
            // sería un rojo permanente en flujos que nunca tocaron el horario.
            updateAppointmentCalls = [];
            const res = await put(server, 'apt-1', { estado: 'completed', notas: 'vino tarde' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(updateAppointmentCalls.length, 1);
        });

        await test('10 · el PUT genérico NUNCA lleva columnas de facturación', async () => {
            // El invariante que sostiene el importe manual: las columnas de facturación se
            // escriben en dos sitios y solo dos (stampBillingSnapshot y setManualPrice).
            // Si algún día alguien añade `precio` al dict de updateAppointment, guardar una
            // cita desde el panel podría pisar una corrección hecha a mano — y este test
            // salta antes de que llegue a producción.
            updateAppointmentCalls = [];
            await put(server, 'apt-1', { estado: 'confirmed', servicio: 'Corte', fecha: '2026-08-10', hora: '10:00', duracionMin: 60 });
            assert.ok(updateAppointmentCalls.length > 0, 'la ruta llamó a updateAppointment');
            const prohibidas = [
                'precio', 'precio_manual', 'precioManual', 'precio_facturado', 'precioFacturado',
                'facturado_at', 'iva_rate', 'servicio_facturado',
            ];
            for (const body of updateAppointmentCalls) {
                for (const k of prohibidas) {
                    assert.ok(!(k in body), `PUT /api/citas/:id no puede transportar ${k}`);
                }
            }
        });
    } finally {
        server.close();
    }

    if (!process.exitCode) console.log('\nTodos los tests de ruta no-show → blacklist OK');
    process.exit(process.exitCode || 0);
})();
