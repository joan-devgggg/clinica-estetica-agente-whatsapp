/**
 * tests/limpiar-pruebas-web.test.js — los guardianes del único script que BORRA.
 *
 * `scripts/limpiar-pruebas-web.js` borra un contacto, y borrar un contacto se lleva por
 * cascada y en silencio su conversación entera (CLAUDE.md, hecho 7: Olga Yarmak, 30
 * mensajes auditados, 11/08/2026). Lo que decide si sigue adelante es `evaluarBloqueos`,
 * y por eso vive en una función PURA: probarla contra producción exigiría tener allí una
 * ficha de prueba, y entonces la red solo existiría los días en que la hubiera.
 *
 * Los dos bloques que hay que leer juntos, porque miden cosas opuestas:
 *
 *   · «una ficha SOLO de web pasa» — es el que impide que un guardián se quede encendido
 *     para siempre. Sin él, un script que aborta SIEMPRE pasaría todos los demás bloques
 *     de este fichero con matrícula de honor y sería inútil el día que hiciera falta.
 *   · los de cada contaminante — cada uno mete UNA suciedad sobre esa misma ficha limpia
 *     y exige que aparezca ESE motivo. Uno por uno, para que un guardián que deje de
 *     mirar salga en rojo él solo y no tapado por el de al lado.
 *
 * ── Sabotajes medidos (20/08/2026) ───────────────────────────────────────────────────────
 *   1. quitar el guardián de `source !== 'web'` ................................ 2 rojos
 *   2. `cobros` deja de mirarse .................................................. 2 rojos
 *   3. los mensajes pasan siempre (como si --con-conversacion fuera el default) ... 1 rojo
 *   4. `origen` se compara con `!== null`: la ficha LIMPIA pasa a bloquear ....... 14 rojos
 */
const assert = require('assert');
const { evaluarBloqueos } = require('../scripts/limpiar-pruebas-web');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// La ficha EXACTA que deja el enlace público: `saveLead({telefono, origen:'web'})` sobre un
// teléfono desconocido, más una cita con `source:'web'`. Nada más — el enlace no escribe en
// `messages`, ni en `pending_actions`, ni en `broadcast_sends`.
const limpia = () => ({
    contacto: { origen: 'web', is_vip: false, visit_count: 0, full_name: 'PRUEBA WEB 1' },
    citas: [{ id: 'c1', source: 'web', starts_at: '2026-11-04T10:00:00Z', service: 'Corte' }],
    mensajes: [], pendientes: [], seguimientos: [], campanas: [], cobros: [], ajenas: [],
    permitirConversacion: false,
});

// ─── El bloque que hace que el script sirva para algo ────────────────────────────────────

test('una ficha SOLO de web pasa: ningún guardián se queda encendido para siempre', () => {
    assert.deepStrictEqual(evaluarBloqueos(limpia()), []);
});

test('sin citas tampoco bloquea: una reserva que falló deja ficha y nada más', () => {
    const inv = limpia();
    inv.citas = [];
    assert.deepStrictEqual(evaluarBloqueos(inv), []);
});

// ─── Un contaminante cada vez ────────────────────────────────────────────────────────────

function unSoloMotivo(inv, trozo) {
    const b = evaluarBloqueos(inv);
    assert.strictEqual(b.length, 1, `esperaba UN motivo, salieron ${b.length}: ${JSON.stringify(b)}`);
    assert.ok(b[0].includes(trozo), `el motivo no menciona '${trozo}': ${b[0]}`);
}

test('origen distinto de web bloquea', () => {
    const inv = limpia();
    inv.contacto.origen = 'whatsapp';
    unSoloMotivo(inv, "origen='whatsapp'");
});

test('origen a null bloquea, y lo dice como null (no como cadena vacía)', () => {
    const inv = limpia();
    inv.contacto.origen = null;
    unSoloMotivo(inv, "origen='null'");
});

test('una cita que NO es de web bloquea, y sale con su fecha y su source', () => {
    const inv = limpia();
    inv.citas.push({ id: 'c2', source: 'manual', starts_at: '2026-09-01T09:00:00Z' });
    unSoloMotivo(inv, '2026-09-01T09:00:00Z [manual]');
});

test('una cita con source a null NO se cuela por parecerse a web', () => {
    const inv = limpia();
    inv.citas = [{ id: 'c1', source: null, starts_at: '2026-09-01T09:00:00Z' }];
    unSoloMotivo(inv, '[null]');
});

test('un cobro bloquea, y avisa de que el RESTRICT haría fallar el borrado entero', () => {
    const inv = limpia();
    inv.cobros = [{ id: 'k1', estado: 'anulado', importe_total: 0 }];
    unSoloMotivo(inv, 'RESTRICT');
});

test('un envío de campaña bloquea: a esa ficha se le ha escrito de verdad', () => {
    const inv = limpia();
    inv.campanas = [{ id: 'b1', campaign_key: 'verano', status: 'sent' }];
    unSoloMotivo(inv, 'campaña');
});

test('una pending_action bloquea', () => {
    const inv = limpia();
    inv.pendientes = [{ id: 'p1', type: 'escalation', status: 'pending' }];
    unSoloMotivo(inv, 'pending_actions');
});

test('un seguimiento bloquea', () => {
    const inv = limpia();
    inv.seguimientos = [{ id: 's1', regla_key: 'hidratacion', estado: 'pendiente' }];
    unSoloMotivo(inv, 'seguimientos');
});

test('una fila de OTRO contacto apuntando a estas citas bloquea', () => {
    const inv = limpia();
    inv.ajenas = [{ id: 'x1', contact_id: 'otro' }];
    unSoloMotivo(inv, 'OTRO contacto');
});

test('VIP bloquea aunque todo lo demás sea de web', () => {
    const inv = limpia();
    inv.contacto.is_vip = true;
    unSoloMotivo(inv, 'VIP');
});

test('visit_count > 0 bloquea: esa ficha ha pisado el salón', () => {
    const inv = limpia();
    inv.contacto.visit_count = 3;
    unSoloMotivo(inv, 'visit_count=3');
});

// ─── Los mensajes: el único bloqueo con salida, y su salida no abre ningún otro ──────────

test('los mensajes bloquean por defecto, y el motivo lleva CUÁNTOS son', () => {
    const inv = limpia();
    inv.mensajes = [{ id: 'm1' }, { id: 'm2' }];
    unSoloMotivo(inv, '2 mensaje(s)');
});

test('--con-conversacion levanta SOLO el de los mensajes', () => {
    const inv = limpia();
    inv.mensajes = [{ id: 'm1' }];
    inv.permitirConversacion = true;
    assert.deepStrictEqual(evaluarBloqueos(inv), []);
});

test('--con-conversacion NO exonera de nada más', () => {
    const inv = limpia();
    inv.mensajes = [{ id: 'm1' }];
    inv.permitirConversacion = true;
    inv.contacto.origen = 'manual';
    inv.cobros = [{ id: 'k1' }];
    const b = evaluarBloqueos(inv);
    assert.strictEqual(b.length, 2);
    assert.ok(b.some(x => x.includes("origen='manual'")));
    assert.ok(b.some(x => x.includes('RESTRICT')));
});

// ─── Y el caso degenerado ────────────────────────────────────────────────────────────────

test('sin ficha no hay vía libre: devuelve bloqueo, no lista vacía', () => {
    const b = evaluarBloqueos({ contacto: null });
    assert.strictEqual(b.length, 1);
});

test('un inventario a medias (campos ausentes) no se lee como «no hay nada»', () => {
    // Si mañana alguien llama a evaluarBloqueos sin pasar `cobros`, el default es [] y eso
    // es correcto AQUÍ —quien lee la BD ya aborta si la lectura falla— pero la ficha sigue
    // teniendo que pasar sus propios guardianes.
    const b = evaluarBloqueos({ contacto: { origen: 'manual' } });
    assert.strictEqual(b.length, 1);
    assert.ok(b[0].includes("origen='manual'"));
});
