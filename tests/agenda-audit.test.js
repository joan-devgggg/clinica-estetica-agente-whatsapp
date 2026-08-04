// Coherencia citas ↔ horario real (tests/lib/agenda-audit.js).
//
// Los cinco fallos que el sistema no detectaba: la dueña edita horarios y skills desde el
// panel y las citas YA reservadas no se mueven ni avisan. Cada caso de abajo es una cita que
// hoy se colaría en silencio hasta que la clienta se presenta.
//
// Hermético: fixtures en memoria, cero red. La función es pura a propósito para poder
// probarla así; el runner contra Supabase (verify:sante:agenda) sólo le pasa datos reales.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { auditAgenda } = require('./lib/agenda-audit');

function test(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

// ── Fixtures: nombres y categorías REALES del catálogo de Sante ──────────────────────
const CATALOG = [
    { nombre: 'Hombre',              categoria: 'Cortes',          precio: 25,  duracion: 30 },
    { nombre: 'Color raíz',          categoria: 'Color Premium',   precio: 75,  duracion: 90 },
    { nombre: 'Ampolla cuidado',     categoria: 'Color Premium',   precio: 15,  duracion: 15 },
    { nombre: 'Dermapen Hair Loss',  categoria: 'Dermapen Hair Loss', precio: 90, duracion: 80 },
    { nombre: 'Manicura + gel',      categoria: 'Manicura/Pedicura',  precio: 35, duracion: 60 },
];

// Convención del proyecto (date-utils.mondayDow): 0=lunes … 6=domingo.
const IRINA = { id: 'sty-irina', name: 'Irina', active: true, skills: ['Cortes', 'Color Premium'] };
const TRICO = { id: 'sty-trico', name: 'Yulia-Tricóloga', active: true, skills: ['Dermapen Hair Loss'] };
const STYLISTS = [IRINA, TRICO];

// Irina: martes(1) y jueves(3) 10:00–19:00. Yulia-Tricóloga: lunes(0) 10:00–18:00.
const SCHEDULES = new Map([
    [IRINA.id, [
        { day_of_week: 1, start_time: '10:00:00', end_time: '19:00:00' },
        { day_of_week: 3, start_time: '10:00:00', end_time: '19:00:00' },
    ]],
    [TRICO.id, [{ day_of_week: 0, start_time: '10:00:00', end_time: '18:00:00' }]],
]);
const SIN_BLOQUEOS = new Map([[IRINA.id, []], [TRICO.id, []]]);

// 2026-08-04 es martes; 2026-08-05 miércoles; 2026-08-06 jueves; 2026-08-03 lunes.
const cita = (over = {}) => ({
    id: 'c1',
    starts_at: '2026-08-04T15:30:00.000Z', // 17:30 Madrid
    ends_at: '2026-08-04T16:30:00.000Z',   // 18:30 Madrid
    stylist_id: IRINA.id,
    service: 'Color raíz',
    clienta: 'Gabriela',
    ...over,
});

const run = (citas, over = {}) => auditAgenda({
    citas, stylists: STYLISTS, schedules: SCHEDULES, blocks: SIN_BLOQUEOS, catalog: CATALOG, ...over,
});
const tipos = (hallazgos) => hallazgos.map(h => h.tipo);

// ── Caso base: nada que reportar ─────────────────────────────────────────────────────
test('cita que encaja en el horario → sin hallazgos', () => {
    assert.deepStrictEqual(run([cita()]), []);
});

// ── 1 · día que la estilista ya no trabaja ───────────────────────────────────────────
test('día no laborable: Irina ya no trabaja los miércoles', () => {
    const h = run([cita({ starts_at: '2026-08-05T09:00:00.000Z', ends_at: '2026-08-05T10:00:00.000Z' })]);
    assert.deepStrictEqual(tipos(h), ['dia-no-laborable']);
    assert.strictEqual(h[0].severidad, 'error');
    assert.match(h[0].detalle, /miércoles/);
    assert.match(h[0].detalle, /martes, jueves/); // dice qué días SÍ trabaja, para reubicar
});

// ── 2 · fuera de franja, con ends_at incluido ────────────────────────────────────────
test('fuera de franja: termina 30 min después del cierre', () => {
    // 17:30–19:30 Madrid, con la franja cerrando a las 19:00. Caso real del 04/08/2026.
    const h = run([cita({ ends_at: '2026-08-04T17:30:00.000Z' })]);
    assert.deepStrictEqual(tipos(h), ['fuera-de-franja']);
    assert.match(h[0].detalle, /17:30–19:30/);
});

test('fuera de franja: empezar antes de abrir también cuenta', () => {
    const h = run([cita({ starts_at: '2026-08-04T07:00:00.000Z', ends_at: '2026-08-04T08:00:00.000Z' })]); // 09:00–10:00
    assert.deepStrictEqual(tipos(h), ['fuera-de-franja']);
});

test('ends_at EXACTAMENTE en el cierre es válido, no es un hallazgo', () => {
    // El borde importa: 17:30–19:00 con cierre a las 19:00 es una cita legítima y marcarla
    // sería un falso positivo que enseña a ignorar el informe.
    assert.deepStrictEqual(run([cita({ starts_at: '2026-08-04T15:30:00.000Z', ends_at: '2026-08-04T17:00:00.000Z' })]), []);
});

test('turno partido: la cita vale si cabe entera en UNA de las franjas del día', () => {
    const schedules = new Map([
        [IRINA.id, [
            { day_of_week: 1, start_time: '10:00:00', end_time: '13:00:00' },
            { day_of_week: 1, start_time: '16:00:00', end_time: '19:00:00' },
        ]],
        [TRICO.id, []],
    ]);
    // 17:30–18:30 cabe en la franja de tarde.
    assert.deepStrictEqual(run([cita()], { schedules }), []);
    // 12:30–16:30 cruza el hueco de comida: no cabe en ninguna.
    const h = run([cita({ starts_at: '2026-08-04T10:30:00.000Z', ends_at: '2026-08-04T14:30:00.000Z' })], { schedules });
    assert.deepStrictEqual(tipos(h), ['fuera-de-franja']);
});

// ── 3 · bloqueo manual metido después de la cita ─────────────────────────────────────
test('dentro de bloqueo: vacaciones añadidas sobre una cita ya reservada', () => {
    const blocks = new Map([[IRINA.id, [
        { starts_at: '2026-08-04T12:00:00.000Z', ends_at: '2026-08-04T18:00:00.000Z', reason: 'vacaciones' },
    ]], [TRICO.id, []]]);
    const h = run([cita()], { blocks });
    assert.deepStrictEqual(tipos(h), ['dentro-de-bloqueo']);
    assert.match(h[0].detalle, /vacaciones/);
});

test('bloqueo que NO toca la cita no genera hallazgo', () => {
    const blocks = new Map([[IRINA.id, [
        { starts_at: '2026-08-04T05:00:00.000Z', ends_at: '2026-08-04T08:00:00.000Z', reason: 'formación' },
    ]], [TRICO.id, []]]);
    assert.deepStrictEqual(run([cita()], { blocks }), []);
});

// ── 4 · skill que la estilista ya no tiene ───────────────────────────────────────────
test('sin skill: el COMPLEMENTO de un multiservicio es el que no encaja', () => {
    // Caso real del 19/08/2026: "Dermapen Hair Loss + Ampolla cuidado" con la tricóloga, que
    // no tiene Color Premium. El servicio principal sí encaja: sin mirar segmento a segmento
    // esto pasa desapercibido.
    const h = run([cita({
        starts_at: '2026-08-03T08:00:00.000Z', ends_at: '2026-08-03T09:35:00.000Z', // lunes 10:00–11:35
        stylist_id: TRICO.id, service: 'Dermapen Hair Loss + Ampolla cuidado',
    })]);
    assert.deepStrictEqual(tipos(h), ['sin-skill']);
    assert.strictEqual(h[0].severidad, 'aviso'); // puede ser decisión deliberada de la dueña
    assert.match(h[0].detalle, /Color Premium/);
    assert.match(h[0].detalle, /Ampolla cuidado/);
});

test('servicio que ya no existe en el catálogo se avisa, no se traga', () => {
    const h = run([cita({ service: 'Tratamiento que la dueña borró' })]);
    assert.deepStrictEqual(tipos(h), ['servicio-irresoluble']);
});

// ── 5 · solapes de la misma estilista ────────────────────────────────────────────────
test('solape: dos citas de la misma estilista a la vez', () => {
    const h = run([
        cita({ id: 'a', starts_at: '2026-08-04T08:00:00.000Z', ends_at: '2026-08-04T10:00:00.000Z' }), // 10:00–12:00
        cita({ id: 'b', starts_at: '2026-08-04T09:00:00.000Z', ends_at: '2026-08-04T11:00:00.000Z' }), // 11:00–13:00
    ]);
    assert.deepStrictEqual(tipos(h), ['solape']);
    assert.strictEqual(h[0].cita.id, 'b'); // se señala la segunda, que es la que sobra
});

test('citas pegadas (una acaba cuando empieza la otra) NO son solape', () => {
    assert.deepStrictEqual(run([
        cita({ id: 'a', starts_at: '2026-08-04T08:00:00.000Z', ends_at: '2026-08-04T10:00:00.000Z' }),
        cita({ id: 'b', starts_at: '2026-08-04T10:00:00.000Z', ends_at: '2026-08-04T11:00:00.000Z' }),
    ]), []);
});

test('mismo horario pero estilistas DISTINTAS no es solape', () => {
    assert.deepStrictEqual(run([
        cita({ id: 'a', starts_at: '2026-08-03T08:00:00.000Z', ends_at: '2026-08-03T09:00:00.000Z', stylist_id: TRICO.id, service: 'Dermapen Hair Loss' }),
        cita({ id: 'b', starts_at: '2026-08-03T08:00:00.000Z', ends_at: '2026-08-03T09:00:00.000Z', stylist_id: 'sty-otra' }),
    ]).filter(h => h.tipo === 'solape'), []);
});

// ── Casos de borde que no deben romper el auditor ────────────────────────────────────
test('cita sin estilista se avisa y no arrastra el resto de comprobaciones', () => {
    const h = run([cita({ stylist_id: null })]);
    assert.deepStrictEqual(tipos(h), ['sin-estilista']);
});

test('estilista sin ningún horario configurado es un error, no un silencio', () => {
    const h = run([cita()], { schedules: new Map([[IRINA.id, []], [TRICO.id, []]]) });
    assert.deepStrictEqual(tipos(h), ['sin-horario']);
});

test('una cita puede acumular varios hallazgos independientes', () => {
    // Miércoles (Irina no trabaja) + servicio de una categoría que no domina.
    const h = run([cita({
        starts_at: '2026-08-05T09:00:00.000Z', ends_at: '2026-08-05T10:00:00.000Z',
        service: 'Dermapen Hair Loss',
    })]);
    assert.deepStrictEqual(tipos(h).sort(), ['dia-no-laborable', 'sin-skill']);
});

test('los hallazgos salen ordenados por fecha y hora', () => {
    const h = run([
        cita({ id: 'tarde', starts_at: '2026-08-05T14:00:00.000Z', ends_at: '2026-08-05T15:00:00.000Z' }),
        cita({ id: 'pronto', starts_at: '2026-08-05T07:00:00.000Z', ends_at: '2026-08-05T08:00:00.000Z' }),
    ]);
    assert.deepStrictEqual(h.map(x => x.cita.id), ['pronto', 'tarde']);
});
