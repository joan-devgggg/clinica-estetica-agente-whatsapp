// El bot no sabía consultar una cita que YA existe.
//
// Hasta ahora, "¿a qué hora tengo la cita?" o "es para mi cita de las 6" no tenían ningún
// camino: el LLM nunca veía las citas reales de la clienta (partialDataWithCtx solo le
// inyecta huecos LIBRES), así que hacía lo único que sabía —arrancar una reserva nueva—.
// Ese es el fallo de fondo del incidente de Valeria (01/08/2026).
//
// Este fichero cubre las tres capas del arreglo:
//   Capa 0 — identidad tolerante a duplicados (phoneVariants, findContactIdsByPhone).
//   Capa 2 — detectores deterministas sobre el mensaje de la clienta.
//   Capa 3 — el gating en bot.js (consultar / referirse / cambiar / cancelar).
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');

// ─── Doble de Supabase ──────────────────────────────────────────────────────────
// db.js hace `require('./supabase')` al cargar. Lo sustituimos por un constructor de
// consultas que registra la última query construida (para poder afirmar sobre los filtros
// REALES: qué variantes de teléfono se buscan, si es .in() o .eq()) y devuelve las filas
// que cada test configure.
let ultimaQuery = null;
let filasPorTabla = {};
let errorPorTabla = {};

function makeQuery(tabla) {
    const q = { tabla, select: null, eq: {}, in: {}, neq: {}, gte: {} };
    const api = {
        select(cols) { q.select = cols; return api; },
        eq(col, val) { q.eq[col] = val; return api; },
        in(col, vals) { q.in[col] = vals; return api; },
        neq(col, val) { q.neq[col] = val; return api; },
        gte(col, val) { q.gte[col] = val; return api; },
        order() { return api; },
        limit() { return api; },
        maybeSingle() { return api; },
        single() { return api; },
        then(res, rej) {
            ultimaQuery = q;
            const error = errorPorTabla[tabla] || null;
            const data = error ? null : (filasPorTabla[tabla] || []);
            return Promise.resolve({ data, error }).then(res, rej);
        },
    };
    return api;
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: makeQuery },
};

const db = require('../services/db');
const H = require('../services/helpers');

function reset() {
    ultimaQuery = null;
    filasPorTabla = {};
    errorPorTabla = {};
}

function test(name, fn) {
    reset();
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(
                () => console.log(`ok - ${name}`),
                e => { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; },
            );
        }
        console.log(`ok - ${name}`);
    } catch (e) {
        console.error(`fail - ${name}`); console.error(e); process.exitCode = 1;
    }
    return Promise.resolve();
}

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

async function main() {

// ─── Capa 0 · phoneVariants ─────────────────────────────────────────────────────

await test('phoneVariants · el caso Valeria: canónico y forma sin prefijo son la misma persona', () => {
    const v = db.phoneVariants('34611209542');
    assert.ok(v.includes('34611209542'), 'falta la forma canónica');
    assert.ok(v.includes('611209542'), 'falta la forma sin prefijo (la que tecleó el panel)');
    // Simétrico: da igual por cuál de las dos formas se pregunte.
    assert.deepStrictEqual(
        [...db.phoneVariants('611209542')].sort(),
        [...v].sort(),
        'preguntar por la forma sin prefijo debe dar el mismo conjunto',
    );
});

await test('phoneVariants · incluye la forma con "+" (updateLeadById no normaliza)', () => {
    const v = db.phoneVariants('34611209542');
    assert.ok(v.includes('+34611209542'));
    assert.ok(v.includes('+611209542'));
});

await test('phoneVariants · idempotente y sin duplicados', () => {
    const v = db.phoneVariants('+34 611 209 542');
    assert.strictEqual(new Set(v).size, v.length, 'no debe repetir variantes');
    assert.deepStrictEqual(v, db.phoneVariants(db.phoneVariants('34611209542')[0]));
});

await test('phoneVariants · NO inventa variantes para números que no son móvil español', () => {
    // Un fijo español y un número extranjero no tienen "forma sin prefijo": recortarles
    // dígitos generaría un número de otra persona.
    assert.deepStrictEqual(db.phoneVariants('34911234567'), ['34911234567', '+34911234567']);
    assert.deepStrictEqual(db.phoneVariants('380671234567'), ['380671234567', '+380671234567']);
});

await test('phoneVariants · vacío para entradas no utilizables', () => {
    assert.deepStrictEqual(db.phoneVariants(''), []);
    assert.deepStrictEqual(db.phoneVariants(null), []);
    assert.deepStrictEqual(db.phoneVariants(undefined), []);
});

// ─── Capa 0 · findContactIdsByPhone ─────────────────────────────────────────────

await test('findContactIdsByPhone · busca TODAS las variantes, no solo la canónica', async () => {
    filasPorTabla.contacts = [
        { id: 'c-canonico', wa_phone: '34611209542', created_at: '2026-01-01T00:00:00Z' },
    ];
    await db.findContactIdsByPhone(ORG, '34611209542');
    assert.strictEqual(ultimaQuery.tabla, 'contacts');
    assert.strictEqual(ultimaQuery.eq.organization_id, ORG, 'debe seguir filtrando por org');
    assert.ok(ultimaQuery.in.wa_phone, 'debe usar .in(), no .eq(): el duplicado tiene otro string');
    assert.ok(ultimaQuery.in.wa_phone.includes('611209542'));
    assert.ok(ultimaQuery.in.wa_phone.includes('34611209542'));
});

await test('findContactIdsByPhone · el contacto canónico va primero, el duplicado detrás', async () => {
    filasPorTabla.contacts = [
        // El duplicado es MÁS reciente: sin la regla de "canónico primero" ganaría él.
        { id: 'c-duplicado', wa_phone: '611209542',   created_at: '2026-08-01T10:00:00Z' },
        { id: 'c-canonico',  wa_phone: '34611209542', created_at: '2025-03-01T10:00:00Z' },
    ];
    const ids = await db.findContactIdsByPhone(ORG, '34611209542');
    assert.deepStrictEqual(ids, ['c-canonico', 'c-duplicado']);
});

await test('findContactIdsByPhone · sin teléfono no toca la BD', async () => {
    const ids = await db.findContactIdsByPhone(ORG, '');
    assert.deepStrictEqual(ids, []);
    assert.strictEqual(ultimaQuery, null, 'no debe lanzar ninguna query');
});

await test('findContactIdsByPhone · un error de lectura LANZA (no devuelve [])', async () => {
    // Igual que assertRead en el resto de lecturas: un fallo de infraestructura no puede
    // disfrazarse de "esta clienta no existe" — por ahí es por donde el bot acabaría
    // diciéndole que no tiene ninguna cita.
    errorPorTabla.contacts = { message: 'timeout', code: '57014' };
    await assert.rejects(() => db.findContactIdsByPhone(ORG, '34611209542'), /contacts/);
});

// ─── Capa 0 · getUpcomingAppointments con varios contact_id ─────────────────────

await test('getUpcomingAppointments · acepta un array de ids y usa .in(contact_id)', async () => {
    filasPorTabla.appointments = [];
    await db.getUpcomingAppointments(ORG, ['c-canonico', 'c-duplicado']);
    assert.strictEqual(ultimaQuery.tabla, 'appointments');
    assert.deepStrictEqual(ultimaQuery.in.contact_id, ['c-canonico', 'c-duplicado']);
    assert.strictEqual(ultimaQuery.neq.status, 'cancelled', 'las canceladas no cuentan');
});

await test('getUpcomingAppointments · retrocompatible con un id suelto', async () => {
    filasPorTabla.appointments = [];
    await db.getUpcomingAppointments(ORG, 'c-canonico');
    assert.deepStrictEqual(ultimaQuery.in.contact_id, ['c-canonico']);
});

await test('getUpcomingAppointments · trae el nombre de la estilista ("¿con quién voy?")', async () => {
    filasPorTabla.appointments = [];
    await db.getUpcomingAppointments(ORG, 'c-canonico');
    assert.ok(/stylists!stylist_id\(name\)/.test(ultimaQuery.select), 'falta el join de stylists');
});

await test('getUpcomingAppointments · sin ids utilizables no toca la BD', async () => {
    assert.deepStrictEqual(await db.getUpcomingAppointments(ORG, []), []);
    assert.deepStrictEqual(await db.getUpcomingAppointments(ORG, null), []);
    assert.deepStrictEqual(await db.getUpcomingAppointments(ORG, [null, undefined]), []);
    assert.strictEqual(ultimaQuery, null);
});

// ─── Capa 2 · detectAppointmentQuery ────────────────────────────────────────────

await test('detectAppointmentQuery · las preguntas del enunciado, clasificadas', () => {
    assert.deepStrictEqual(H.detectAppointmentQuery('¿a qué hora tengo la cita?'), { campo: 'hora' });
    assert.deepStrictEqual(H.detectAppointmentQuery('¿qué día vengo? tengo cita esta semana'), { campo: 'dia' });
    assert.deepStrictEqual(H.detectAppointmentQuery('¿con quién voy? mi cita es el jueves'), { campo: 'estilista' });
    assert.deepStrictEqual(H.detectAppointmentQuery('¿cuándo es mi cita?'), { campo: 'dia' });
});

await test('detectAppointmentQuery · pregunta general sin campo concreto', () => {
    assert.deepStrictEqual(H.detectAppointmentQuery('¿tengo cita mañana?'), { campo: 'general' });
    assert.deepStrictEqual(H.detectAppointmentQuery('¿sigue en pie mi cita?'), { campo: 'general' });
});

await test('detectAppointmentQuery · EN / RU / UK', () => {
    assert.ok(H.detectAppointmentQuery('what time is my appointment?'));
    assert.ok(H.detectAppointmentQuery('when is my appointment'));
    assert.ok(H.detectAppointmentQuery('во сколько моя запись?'));
    assert.ok(H.detectAppointmentQuery('коли мій запис?'));
});

await test('detectAppointmentQuery · NEGATIVOS: pedir cita nueva no es consultar', () => {
    // Este es el guard que impide que la funcionalidad nueva secuestre el flujo de reserva.
    assert.strictEqual(H.detectAppointmentQuery('quiero pedir cita'), null);
    assert.strictEqual(H.detectAppointmentQuery('quiero una cita a las 6'), null);
    assert.strictEqual(H.detectAppointmentQuery('¿puedo reservar cita para el jueves?'), null);
    assert.strictEqual(H.detectAppointmentQuery('tengo que pedir cita'), null);
    assert.strictEqual(H.detectAppointmentQuery('hola, quiero reservar'), null);
    assert.strictEqual(H.detectAppointmentQuery('¿a qué hora abrís?'), null);
    assert.strictEqual(H.detectAppointmentQuery('i want to book an appointment'), null);
    assert.strictEqual(H.detectAppointmentQuery('хочу записаться'), null);
});

// ─── Capa 2 · detectExistingAppointmentReference ────────────────────────────────

await test('detectExistingAppointmentReference · "es para mi cita de las 6" (caso Valeria)', () => {
    const r = H.detectExistingAppointmentReference('es para mi cita de las 6');
    assert.ok(r, 'debe detectar que habla de una cita existente');
    // 18:00 primero: el salón trabaja sobre todo por la tarde, pero se ofrecen las dos
    // lecturas para que gane la que exista de verdad en la agenda.
    assert.deepStrictEqual(r.horas, ['18:00', '06:00']);
});

await test('detectExistingAppointmentReference · hora explícita y de mañana', () => {
    assert.deepStrictEqual(H.detectExistingAppointmentReference('mi cita de las 10:30').horas, ['10:30']);
    assert.deepStrictEqual(H.detectExistingAppointmentReference('mi cita de las 9 de la mañana').horas, ['09:00', '21:00']);
    assert.deepStrictEqual(H.detectExistingAppointmentReference('mi cita de las 17').horas, ['17:00']);
});

await test('detectExistingAppointmentReference · día de la semana', () => {
    assert.strictEqual(H.detectExistingAppointmentReference('la cita que tengo el jueves').diaSemana, 3);
    assert.strictEqual(H.detectExistingAppointmentReference('no puedo ir a mi cita del miércoles').diaSemana, 2);
    assert.strictEqual(H.detectExistingAppointmentReference('mi cita').diaSemana, null);
});

await test('detectExistingAppointmentReference · "quiero añadir algo a mi cita"', () => {
    const r = H.detectExistingAppointmentReference('quiero añadir algo a mi cita');
    assert.ok(r);
    assert.deepStrictEqual(r.horas, []);
});

await test('detectExistingAppointmentReference · NEGATIVOS: no confunde reserva nueva', () => {
    assert.strictEqual(H.detectExistingAppointmentReference('quiero una cita a las 6'), null);
    assert.strictEqual(H.detectExistingAppointmentReference('quiero pedir cita para el jueves'), null);
    assert.strictEqual(H.detectExistingAppointmentReference('me viene bien a las 6'), null);
    assert.strictEqual(H.detectExistingAppointmentReference('sí, las 18:00 perfecto'), null);
});

await test('detectExistingAppointmentReference · "mi cita del 6" es día, no hora', () => {
    // Sin "las"/"at" delante, un número suelto es día del mes: leerlo como hora casaría
    // contra la cita equivocada.
    assert.deepStrictEqual(H.detectExistingAppointmentReference('mi cita del 6').horas, []);
});

// ─── Capa 2 · mensajes deterministas ────────────────────────────────────────────

const CITA = {
    id: 'a-1', servicio: 'Color raíz', fecha: '2026-08-06', hora: '18:00',
    horaFin: '19:30', estilista: 'Irina', stylistId: 's-1', status: 'confirmed',
};

await test('buildCitasVivasMsg · da la cita entera: fecha, hora, servicio y estilista', () => {
    const msg = H.buildCitasVivasMsg({ citas: [CITA], campo: 'hora', language: 'es' });
    assert.ok(msg.includes('18:00'), 'falta la hora');
    assert.ok(msg.includes('Color raíz'), 'falta el servicio');
    assert.ok(msg.includes('Irina'), 'falta la estilista');
    assert.ok(/jueves/i.test(msg), 'falta el día de la semana');
});

await test('buildCitasVivasMsg · sin citas no inventa ninguna', () => {
    const msg = H.buildCitasVivasMsg({ citas: [], language: 'es' });
    assert.ok(/no me consta/i.test(msg));
    assert.ok(!msg.includes('📅'));
});

await test('buildElegirCitaMsg · lista las opciones sin elegir por ella', () => {
    const otra = { ...CITA, id: 'a-2', servicio: 'Manicura', fecha: '2026-08-04', hora: '11:00' };
    const msg = H.buildElegirCitaMsg({ citas: [CITA, otra], accion: 'cancelar', language: 'es' });
    assert.ok(msg.includes('Color raíz') && msg.includes('Manicura'));
    assert.ok(/cu[aá]l/i.test(msg));
});

await test('mensajes · los 4 idiomas responden sin caer a español', () => {
    for (const lang of ['en', 'ru', 'uk']) {
        const msg = H.buildCitasVivasMsg({ citas: [CITA], language: lang });
        assert.ok(msg.length > 0);
        assert.ok(!/Tienes esta cita/.test(msg), `${lang} cayó al texto español`);
    }
});

}

main().then(() => process.exit(process.exitCode || 0));
