/**
 * tests/nombres-audit.test.js — La lógica del informe de nombres que faltan.
 *
 * Lo que de verdad protege: que `appointments.full_name` se mire como lo que es. Es NOT
 * NULL, así que "sin nombre" ahí es la CADENA VACÍA que escribe saveAppointment, no un
 * null. Un informe que solo buscara nulos daría cero hallazgos y todos se quedarían
 * tranquilos.
 */
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { test } = require('node:test');
const { auditNombres } = require('./lib/nombres-audit');

const AHORA = new Date('2026-08-05T12:00:00.000Z');
const futuro = '2026-08-20T10:00:00.000Z';
const pasado = '2026-07-01T10:00:00.000Z';

const contacto = (over = {}) => ({
    id: 'c-1', wa_phone: '34600111222', full_name: 'Ana Ruiz',
    estado: 'confirmado', visit_count: 2, is_blacklisted: false,
    created_at: '2026-06-01T10:00:00.000Z', ...over,
});

const cita = (over = {}) => ({
    id: 'a-1', contact_id: 'c-1', full_name: 'Ana Ruiz', phone: '34600111222',
    service: 'Corte', starts_at: futuro, status: 'confirmed', ...over,
});

test('todo con nombre: cero hallazgos', () => {
    const { hallazgos, resumen } = auditNombres({
        contactos: [contacto()], citas: [cita()], ahora: AHORA,
    });
    assert.strictEqual(hallazgos.length, 0);
    assert.strictEqual(resumen.errores, 0);
});

test('appointments.full_name = "" cuenta como sin nombre (NO es null)', () => {
    const { hallazgos, resumen } = auditNombres({
        contactos: [contacto()], citas: [cita({ full_name: '' })], ahora: AHORA,
    });
    assert.strictEqual(resumen.citas_sin_nombre, 1);
    assert.strictEqual(hallazgos[0].columna, 'appointments.full_name');
    assert.strictEqual(hallazgos[0].guardado, '(cadena vacía)');
    // El contacto sí lo tiene: se copia y ya está, sin preguntarle nada a la clienta.
    assert.strictEqual(hallazgos[0].rellenable_con, 'Ana Ruiz');
    assert.strictEqual(resumen.rellenables, 1);
});

test('se miran las DOS columnas por separado, no una en lugar de la otra', () => {
    const { resumen } = auditNombres({
        contactos: [contacto({ full_name: null })],
        citas: [cita({ full_name: 'Ana Ruiz' })],
        ahora: AHORA,
    });
    // El contacto está vacío aunque la cita tenga el nombre: es la columna que leen el bot
    // y el recordatorio, así que el hueco es real.
    assert.strictEqual(resumen.contactos_sin_nombre, 1);
    assert.strictEqual(resumen.citas_sin_nombre, 0);
    assert.strictEqual(resumen.rellenables, 1);
});

test('contacto sin nombre CON cita futura es error; sin citas, aviso', () => {
    const conCita = auditNombres({
        contactos: [contacto({ full_name: null })], citas: [cita({ full_name: '' })], ahora: AHORA,
    });
    assert.strictEqual(conCita.hallazgos[0].tipo, 'contacto-sin-nombre-con-cita');
    assert.strictEqual(conCita.hallazgos[0].severidad, 'error');

    const suelto = auditNombres({ contactos: [contacto({ full_name: null })], citas: [], ahora: AHORA });
    assert.strictEqual(suelto.hallazgos[0].tipo, 'contacto-sin-nombre');
    assert.strictEqual(suelto.hallazgos[0].severidad, 'aviso');
});

test('una cita pasada sin nombre es aviso, no error: ya no hay recordatorio que salvar', () => {
    const { hallazgos } = auditNombres({
        contactos: [contacto()], citas: [cita({ full_name: '', starts_at: pasado })], ahora: AHORA,
    });
    assert.strictEqual(hallazgos[0].severidad, 'aviso');
    assert.strictEqual(hallazgos[0].tipo, 'cita-pasada-sin-nombre');
});

test('los rellenos ocupan la columna pero no sirven para saludar', () => {
    for (const basura of ['cliente', '-', 'null', ' ', 'N/A']) {
        const { resumen } = auditNombres({
            contactos: [contacto({ full_name: basura })], citas: [], ahora: AHORA,
        });
        assert.strictEqual(resumen.contactos_sin_nombre, 1, `"${basura}" debería contar como sin nombre`);
    }
});

test('los nombres reales no se marcan: cirílico, guiones, puntos y paréntesis', () => {
    for (const bueno of ['Юлия', 'Tiffany Dubois-Moiseaux', 'Karima .IGHOUBA', 'Marina Lyon (Blond)']) {
        const { resumen } = auditNombres({
            contactos: [contacto({ full_name: bueno })], citas: [], ahora: AHORA,
        });
        assert.strictEqual(resumen.contactos_sin_nombre, 0, `"${bueno}" es un nombre válido`);
    }
});

test('los errores salen antes que los avisos y lo inminente primero', () => {
    const { hallazgos } = auditNombres({
        contactos: [contacto({ id: 'c-2', full_name: null, wa_phone: '34600999888' })],
        citas: [
            cita({ id: 'a-vieja', full_name: '', starts_at: pasado, contact_id: 'c-9' }),
            cita({ id: 'a-lejos', full_name: '', starts_at: '2026-09-01T10:00:00.000Z', contact_id: 'c-9' }),
            cita({ id: 'a-pronto', full_name: '', starts_at: '2026-08-06T10:00:00.000Z', contact_id: 'c-9' }),
        ],
        ahora: AHORA,
    });
    assert.deepStrictEqual(
        hallazgos.map(h => h.severidad),
        ['error', 'error', 'aviso', 'aviso']
    );
    assert.strictEqual(hallazgos[0].cita_id, 'a-pronto');
});
