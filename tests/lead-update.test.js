// PUT /api/leads/:id — guardado de la ficha de cliente del panel.
//
// El fallo real: el formulario manda SIEMPRE todos los campos y un <input type="date">
// vacío devuelve "". Postgres rechazaba la sentencia entera (22007 «invalid input syntax
// for type date: ""»), db.js no miraba el error, el endpoint devolvía 200 con la fila sin
// tocar y el panel cerraba el sheet como si hubiera guardado. Las 697 fichas de Sante
// tienen fecha_cita NULL → el guardado fallaba en el 100 % de ellas.
//
// Se ejercita la ruta real (node:http) contra un Supabase FALSO que imita el tipado de
// Postgres: '' en una columna date/int/uuid hace fallar TODO el UPDATE. Hermético: cero red.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const http = require('http');

// ─── Supabase falso con tipado tipo Postgres ──────────────────────────────────────────
// Columnas no-text de `contacts`: si les llega '' el UPDATE completo falla y NO se aplica
// ningún campo (exactamente lo que hace Postgres), que es lo que se llevaba por delante
// las alergias/preferencias/notas que sí venían rellenas.
const NON_TEXT = { fecha_cita: 'date', party_size: 'integer', preferred_stylist_id: 'uuid' };

function makeFakeSupabase() {
    const rows = new Map();          // id → row
    let forcedError = null;          // para simular una caída real de Supabase
    const state = {
        seed(row) { rows.set(row.id, { ...row }); },
        get(id) { return rows.get(id); },
        forceError(e) { forcedError = e; },
    };

    function makeBuilder() {
        const q = { op: null, payload: null, filters: [] };
        const matches = (row) => q.filters.every(([col, val]) => row[col] === val);

        function run() {
            if (forcedError) return { data: null, error: forcedError };
            const targets = [...rows.values()].filter(matches);

            if (q.op === 'update') {
                for (const [col, val] of Object.entries(q.payload)) {
                    if (NON_TEXT[col] && val === '') {
                        return { data: null, error: { code: '22007', message: `invalid input syntax for type ${NON_TEXT[col]}: ""` } };
                    }
                }
                for (const row of targets) Object.assign(row, q.payload);
                return { data: null, error: null };
            }
            return { data: targets, error: null };
        }

        const b = {
            from() { return b; },
            select() { return b; },
            update(p) { q.op = 'update'; q.payload = p; return b; },
            eq(col, val) { q.filters.push([col, val]); return b; },
            maybeSingle() { const r = run(); return Promise.resolve({ data: r.error ? null : (r.data?.[0] ?? null), error: r.error }); },
            single() { return b.maybeSingle(); },
            then(onF, onR) { return Promise.resolve(run()).then(onF, onR); },
        };
        return b;
    }
    return { client: { from(t) { return makeBuilder().from(t); } }, state };
}

const fake = makeFakeSupabase();
// Inyectar ANTES de requerir db.js/webhook.js.
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: fake.client };

const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const { app } = require('../webhook');
const db = require('../services/db');

const SANTE_ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const CONTACT_ID = 'f0000000-0000-4000-8000-000000000001';

db.authenticateToken = async (token) =>
    token === 'sante-token' ? { userId: 'user-sante', orgId: SANTE_ORG } : null;

// Ficha típica de Sante: sin fecha ni hora de cita (697/697 están así).
function seedContacto() {
    fake.state.forceError(null);
    fake.state.seed({
        id: CONTACT_ID,
        organization_id: SANTE_ORG,
        wa_phone: '34600000001',
        full_name: 'Clienta de prueba',
        estado: 'pendiente',
        fecha_cita: null,
        hora_cita: null,
        notas: 'notas-viejas',
        allergies: 'alergias-viejas',
        preferences: 'prefs-viejas',
        updated_at: '2026-01-01T00:00:00.000Z',
    });
}

// Cuerpo EXACTO que manda cliente-edit-sheet.tsx para una ficha de salón sin fecha.
const BODY_SANTE = {
    nombre: 'Clienta de prueba',
    estado_cita: 'pendiente',
    fecha_cita: '',
    hora_cita: '',
    allergies: 'Sensibilidad al tinte',
    preferences: 'Prefiere a Irina',
    notas: 'Viene los sábados',
};

function request(server, { method = 'PUT', path, body, token = 'sante-token' }) {
    const { port } = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1', port, method, path,
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
            },
            (res) => {
                let data = '';
                res.on('data', d => (data += d));
                res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
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
        // ── El caso real de Sante: fecha vacía y aun así se guarda ──
        await test('fecha_cita:"" (ficha sin cita) → 200 y alergias/preferencias/notas PERSISTEN', async () => {
            seedContacto();
            const res = await request(server, { path: `/api/leads/${CONTACT_ID}`, body: BODY_SANTE });
            assert.strictEqual(res.status, 200);

            const row = fake.state.get(CONTACT_ID);
            assert.strictEqual(row.allergies, 'Sensibilidad al tinte', 'las alergias llegan a la BD');
            assert.strictEqual(row.preferences, 'Prefiere a Irina');
            assert.strictEqual(row.notas, 'Viene los sábados');
            assert.notStrictEqual(row.updated_at, '2026-01-01T00:00:00.000Z', 'updated_at se refresca');
        });

        await test('fecha_cita:"" se normaliza a NULL, no a cadena vacía', async () => {
            seedContacto();
            await request(server, { path: `/api/leads/${CONTACT_ID}`, body: BODY_SANTE });
            assert.strictEqual(fake.state.get(CONTACT_ID).fecha_cita, null);
        });

        await test('la respuesta 200 devuelve los valores NUEVOS (no la fila vieja)', async () => {
            seedContacto();
            const res = await request(server, { path: `/api/leads/${CONTACT_ID}`, body: BODY_SANTE });
            assert.strictEqual(res.body.allergies, 'Sensibilidad al tinte');
            assert.strictEqual(res.body.notas, 'Viene los sábados');
            assert.strictEqual(res.body.fecha_cita, null);
        });

        await test('personas:"" (columna integer) tampoco tumba el guardado', async () => {
            seedContacto();
            const res = await request(server, {
                path: `/api/leads/${CONTACT_ID}`,
                body: { ...BODY_SANTE, personas: '', ocasion: 'Cumpleaños' },
            });
            assert.strictEqual(res.status, 200);
            const row = fake.state.get(CONTACT_ID);
            assert.strictEqual(row.party_size, null);
            assert.strictEqual(row.occasion, 'Cumpleaños');
        });

        // ── Una fecha de verdad se sigue guardando tal cual (San Remo intacto) ──
        await test('fecha_cita con valor real se guarda sin tocar', async () => {
            seedContacto();
            const res = await request(server, {
                path: `/api/leads/${CONTACT_ID}`,
                body: { ...BODY_SANTE, fecha_cita: '2026-08-03', hora_cita: '17:30' },
            });
            assert.strictEqual(res.status, 200);
            const row = fake.state.get(CONTACT_ID);
            assert.strictEqual(row.fecha_cita, '2026-08-03');
            assert.strictEqual(row.hora_cita, '17:30');
        });

        // ── Un error real de Supabase NO puede disfrazarse de 200 ──
        await test('error de Supabase → 500 con el motivo, nunca 200 falso', async () => {
            seedContacto();
            fake.state.forceError({ code: '42501', message: 'permission denied for table contacts' });
            const res = await request(server, { path: `/api/leads/${CONTACT_ID}`, body: BODY_SANTE });
            assert.strictEqual(res.status, 500, 'no puede ser 200: no se guardó nada');
            assert.ok(/permission denied/.test(res.body.error), `el motivo llega al panel: ${res.body.error}`);
        });

        await test('tras un error de Supabase la fila NO cambió', async () => {
            seedContacto();
            fake.state.forceError({ code: '42501', message: 'permission denied for table contacts' });
            await request(server, { path: `/api/leads/${CONTACT_ID}`, body: BODY_SANTE });
            fake.state.forceError(null);
            assert.strictEqual(fake.state.get(CONTACT_ID).allergies, 'alergias-viejas');
        });

        await test('db.updateLeadById propaga el error en vez de devolver la fila vieja', async () => {
            seedContacto();
            fake.state.forceError({ code: '42501', message: 'permission denied for table contacts' });
            await assert.rejects(
                () => db.updateLeadById(SANTE_ORG, CONTACT_ID, BODY_SANTE),
                /permission denied/
            );
            fake.state.forceError(null);
        });

        await test('sin token → 401 (la ficha no es pública)', async () => {
            seedContacto();
            const res = await request(server, { path: `/api/leads/${CONTACT_ID}`, body: BODY_SANTE, token: null });
            assert.strictEqual(res.status, 401);
        });

        // ── updateLead (ruta del bot): misma normalización, mismo motivo ──
        await test('updateLead con fecha_cita:"" también persiste (no se lleva el resto por delante)', async () => {
            seedContacto();
            const ok = await db.updateLead(SANTE_ORG, {
                leadId: CONTACT_ID, fecha_cita: '', notas: 'nota-del-bot', allergies: 'alergia-del-bot',
            });
            assert.strictEqual(ok, true);
            const row = fake.state.get(CONTACT_ID);
            assert.strictEqual(row.fecha_cita, null, 'la cadena vacía se normaliza a NULL');
            assert.strictEqual(row.notas, 'nota-del-bot');
            assert.strictEqual(row.allergies, 'alergia-del-bot');
        });

        await test('updateLead con fecha/hora reales no se toca (San Remo sigue igual)', async () => {
            seedContacto();
            await db.updateLead(SANTE_ORG, {
                leadId: CONTACT_ID, fecha_cita: '2026-08-03', hora_cita: '21:00',
                personas: 4, ocasion: 'Aniversario', estado_cita: 'confirmado',
            });
            const row = fake.state.get(CONTACT_ID);
            assert.strictEqual(row.fecha_cita, '2026-08-03');
            assert.strictEqual(row.hora_cita, '21:00');
            assert.strictEqual(row.party_size, 4, 'un entero real no se convierte en null');
            assert.strictEqual(row.occasion, 'Aniversario');
            assert.strictEqual(row.estado, 'confirmado');
        });

        await test('updateLead: personas:0 NO se convierte en null (solo "" se normaliza)', async () => {
            seedContacto();
            await db.updateLead(SANTE_ORG, { leadId: CONTACT_ID, personas: 0 });
            assert.strictEqual(fake.state.get(CONTACT_ID).party_size, 0);
        });
    } finally {
        server.close();
    }

    // ── Sincronización de la hora al cambiar de ficha (lib/cliente-form.ts) ──
    const { syncHoraCita, INITIAL_HORA_CITA } = require('../dashboard-app/src/lib/cliente-form.ts');

    await test('horaCita: al seleccionar una ficha se siembra con SU hora', () => {
        const s = syncHoraCita(INITIAL_HORA_CITA, { id: 'c1', hora_cita: '11:00' });
        assert.strictEqual(s.hora, '11:00');
        assert.strictEqual(s.clienteId, 'c1');
    });

    await test('horaCita: cambiar de ficha re-siembra (no arrastra la hora de la anterior)', () => {
        let s = syncHoraCita(INITIAL_HORA_CITA, { id: 'c1', hora_cita: '11:00' });
        s = syncHoraCita(s, { id: 'c2', hora_cita: '17:30' });
        assert.strictEqual(s.hora, '17:30');
    });

    await test('horaCita: ficha sin hora → "" (y no la hora de la ficha anterior)', () => {
        let s = syncHoraCita(INITIAL_HORA_CITA, { id: 'c1', hora_cita: '11:00' });
        s = syncHoraCita(s, { id: 'c2', hora_cita: null });
        assert.strictEqual(s.hora, '');
    });

    await test('horaCita: en la MISMA ficha se conserva lo que eligió la usuaria', () => {
        const s = syncHoraCita(INITIAL_HORA_CITA, { id: 'c1', hora_cita: '11:00' });
        const editado = { ...s, hora: '19:45' };
        const after = syncHoraCita(editado, { id: 'c1', hora_cita: '11:00' });
        assert.strictEqual(after, editado, 'misma referencia → el render no la pisa');
        assert.strictEqual(after.hora, '19:45');
    });

    await test('horaCita: el bug original — montado con cliente null y luego una ficha con hora', () => {
        // El sheet se monta con cliente=null (INITIAL) y solo después llega la ficha:
        // antes se quedaba en "" y cada guardado borraba la hora de la cita.
        let s = syncHoraCita(INITIAL_HORA_CITA, null);
        assert.strictEqual(s.hora, '');
        s = syncHoraCita(s, { id: 'c1', hora_cita: '11:00' });
        assert.strictEqual(s.hora, '11:00', 'no se queda vacía → no borra la hora al guardar');
    });

    if (!process.exitCode) console.log('\nTests de guardado de ficha de cliente OK');
    process.exit(process.exitCode || 0);
})();
