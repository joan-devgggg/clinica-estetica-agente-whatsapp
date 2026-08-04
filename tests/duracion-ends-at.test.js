/**
 * duracion-ends-at.test.js — La duración que se escribe en ends_at
 *
 * ends_at no es decoración de la ficha: es lo que el motor de huecos lee para saber
 * qué parte de la agenda está ocupada. Escribirlo corto no deja una cita "un poco
 * mal", deja hueco declarado donde hay clienta — y el motor lo ofrece.
 *
 * Había tres valores por defecto distintos para el mismo número (bot.js 60,
 * calendar-sante.js 60, db.js 120) y ninguno decía nada al aplicarse. Aquí se fija
 * el contrato: la duración se decide UNA vez (resolveAppointmentDurationMin), quien
 * escribe sabe si es un dato o una suposición, y las capas de abajo no rescatan.
 */

// Hermético: fake creds de Supabase + db mockeado, nunca red real.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    resolveAppointmentDurationMin,
    computeAmpliacionEndsAt,
    DURACION_CITA_FALLBACK_MIN,
} = require('../services/helpers');

const CATALOG = require('./fixtures/sante-catalog.json');

// ─── resolveAppointmentDurationMin ───────────────────────────────────────────

test('duración propia del servicio: se usa tal cual y se marca resuelta', () => {
    const r = resolveAppointmentDurationMin({ nombre: 'K18', categoria: 'Tratamientos', duracion: 60 }, CATALOG);
    assert.deepStrictEqual(r, { minutos: 60, resuelto: true, via: 'servicio' });
});

test('el caso caro: variante sin duracion se recupera del catálogo, no cae a 60', () => {
    // Forma real de `selectedService` cuando el árbol determinista fija {nombre,
    // categoria} y `selectedService_incompleto_sin_match` no completó el objeto.
    // Con `duracion || 60` esta cita de SEIS horas se guardaba como una de 60 min:
    // cinco horas de Airtouch publicadas como libres en la agenda de la colorista.
    const r = resolveAppointmentDurationMin({ nombre: 'Largo', categoria: 'Mechas Airtouch' }, CATALOG);
    assert.strictEqual(r.resuelto, true);
    assert.strictEqual(r.via, 'catalogo');
    assert.strictEqual(r.minutos, 360);
});

test('el nombre suelto es ambiguo: la categoría decide cuál de los cuatro "Largo" es', () => {
    // "Largo" existe en 4 categorías con 4 duraciones (120…360). Resolver por nombre
    // crudo cogería la primera; el nombre COMPLETO desambigua.
    const deco = resolveAppointmentDurationMin({ nombre: 'Largo', categoria: 'Deco Total Blond' }, CATALOG);
    const anti = resolveAppointmentDurationMin({ nombre: 'Largo', categoria: 'Anti-encrespamiento' }, CATALOG);
    assert.strictEqual(deco.minutos, 120);
    assert.strictEqual(anti.minutos, 240);
    assert.notStrictEqual(deco.minutos, anti.minutos);
});

test('servicio irresoluble: sigue habiendo número, pero declarado como suposición', () => {
    const r = resolveAppointmentDurationMin({ nombre: 'Servicio inventado xyz' }, CATALOG);
    assert.strictEqual(r.resuelto, false, 'lo importante no es el 60: es que se sepa que es un 60 inventado');
    assert.strictEqual(r.via, 'fallback');
    assert.strictEqual(r.minutos, DURACION_CITA_FALLBACK_MIN);
});

test('sin servicio en sesión tampoco se finge que hay dato', () => {
    for (const svc of [null, undefined, {}]) {
        assert.strictEqual(resolveAppointmentDurationMin(svc, CATALOG).resuelto, false);
    }
});

test('duraciones basura (0, negativo, texto) no se toman por buenas', () => {
    for (const mala of [0, -30, '', 'sesenta', NaN, null]) {
        const r = resolveAppointmentDurationMin({ nombre: 'Servicio inventado xyz', duracion: mala }, CATALOG);
        assert.strictEqual(r.resuelto, false, `duracion=${JSON.stringify(mala)} no debe pasar como válida`);
    }
});

test('una duración numérica en texto ("90") sí es un dato', () => {
    const r = resolveAppointmentDurationMin({ nombre: 'Lo que sea', duracion: '90' }, CATALOG);
    assert.deepStrictEqual(r, { minutos: 90, resuelto: true, via: 'servicio' });
});

test('catálogo vacío o ausente: no revienta, devuelve suposición declarada', () => {
    assert.strictEqual(resolveAppointmentDurationMin({ nombre: 'Largo', categoria: 'Mechas Airtouch' }, []).resuelto, false);
    assert.strictEqual(resolveAppointmentDurationMin({ nombre: 'Largo' }, undefined).resuelto, false);
});

// ─── computeAmpliacionEndsAt ─────────────────────────────────────────────────

const START = '2026-08-10T09:00:00.000Z';

test('ampliación normal: se suma el upsell NUEVO al fin ya guardado', () => {
    const r = computeAmpliacionEndsAt({
        startsAt: START,
        endsAt: '2026-08-10T13:00:00.000Z',   // cita de 240 min ya en BD
        extraMin: 15,                          // K18 complemento
        totalMin: 9999,                        // no debe mirarse
    });
    assert.strictEqual(r.via, 'ends_at_real');
    assert.strictEqual(r.endsAt.toISOString(), '2026-08-10T13:15:00.000Z');
});

test('aceptar un extra NUNCA acorta la cita aunque la sesión no sepa la duración', () => {
    // El bug: totalMin venía de `selectedService.duracion || 60` + 15 = 75 y el fin se
    // recalculaba desde el inicio → 10:15 en vez de 13:15. La cita perdía 165 minutos
    // que la clienta sigue ocupando, y el motor los ofrecía a otra.
    const r = computeAmpliacionEndsAt({
        startsAt: START,
        endsAt: '2026-08-10T13:00:00.000Z',
        extraMin: 15,
        totalMin: 75,
    });
    assert.ok(r.endsAt > new Date('2026-08-10T13:00:00.000Z'), 'el fin solo puede ir hacia adelante');
    assert.strictEqual(r.endsAt.toISOString(), '2026-08-10T13:15:00.000Z');
});

test('aceptar dos veces el mismo upsell no vuelve a alargar (extraMin 0)', () => {
    const r = computeAmpliacionEndsAt({
        startsAt: START, endsAt: '2026-08-10T13:15:00.000Z', extraMin: 0, totalMin: 255,
    });
    assert.strictEqual(r.endsAt.toISOString(), '2026-08-10T13:15:00.000Z');
});

test('sin ends_at guardado sí toca recalcular desde el inicio, y se marca', () => {
    const r = computeAmpliacionEndsAt({ startsAt: START, endsAt: null, extraMin: 15, totalMin: 255 });
    assert.strictEqual(r.via, 'recalculo', 'el llamante necesita saberlo para registrarlo');
    assert.strictEqual(r.endsAt.toISOString(), '2026-08-10T13:15:00.000Z');
});

test('ends_at corrupto (anterior o igual al inicio) no se usa como base', () => {
    for (const fin of ['2026-08-10T08:00:00.000Z', START, 'no-es-una-fecha']) {
        const r = computeAmpliacionEndsAt({ startsAt: START, endsAt: fin, extraMin: 15, totalMin: 120 });
        assert.strictEqual(r.via, 'recalculo', `ends_at=${fin}`);
        assert.strictEqual(r.endsAt.toISOString(), '2026-08-10T11:00:00.000Z');
    }
});

test('sin base horaria válida no se inventa un fin', () => {
    // 'undefinedTundefined:00' es literal: así queda `${fecha}T${hora}:00` cuando la
    // sesión no tiene fecha/hora. No es Invalid Date — V8 lo lee como el año 2000.
    for (const inicio of [null, undefined, '', 'undefinedTundefined:00', '2026-08-10', {}]) {
        const r = computeAmpliacionEndsAt({ startsAt: inicio, endsAt: null, extraMin: 15, totalMin: 120 });
        assert.deepStrictEqual(r, { endsAt: null, via: 'sin_base' });
    }
});

test('acepta objetos Date igual que strings ISO', () => {
    const r = computeAmpliacionEndsAt({
        startsAt: new Date(START), endsAt: new Date('2026-08-10T13:00:00.000Z'), extraMin: 30,
    });
    assert.strictEqual(r.endsAt.toISOString(), '2026-08-10T13:30:00.000Z');
});

// ─── Contrato de calendar-sante: abajo no se rescata ─────────────────────────

const db = require('../services/db');
const calendarSante = require('../services/calendar-sante');

async function conDbEspiada(fn) {
    const origS = db.saveAppointment, origU = db.updateAppointment;
    const calls = { save: [], update: [] };
    db.saveAppointment = async (orgId, contactId, opts) => { calls.save.push(opts); return { id: 'NUEVA' }; };
    db.updateAppointment = async (orgId, id, campos) => { calls.update.push(campos); return { id }; };
    try { return await fn(calls); } finally { db.saveAppointment = origS; db.updateAppointment = origU; }
}

const SLOT = { fecha: '2026-08-10', hora: '11:00', stylistId: 'est-1' };

test('bookAppointment sin duración: falla en alto y NO escribe', async () => {
    await conDbEspiada(async calls => {
        for (const mala of [undefined, null, 0, '', 'sesenta', -30]) {
            const r = await calendarSante.bookAppointment('org', SLOT, 'c1', { servicio: 'X', duracionMin: mala });
            assert.strictEqual(r.success, false, `duracionMin=${JSON.stringify(mala)}`);
            assert.strictEqual(r.reason, 'duracion_invalida');
        }
        assert.strictEqual(calls.save.length, 0, 'ninguna cita escrita con duración inventada');
    });
});

test('bookAppointment pasa la duración TAL CUAL, sin sustituirla por 60', async () => {
    await conDbEspiada(async calls => {
        const r = await calendarSante.bookAppointment('org', SLOT, 'c1', { servicio: 'X', duracionMin: 360 });
        assert.strictEqual(r.success, true);
        assert.strictEqual(calls.save[0].duracionMin, 360);
    });
});

test('rescheduleAppointment sin duración: falla en alto y NO mueve la cita', async () => {
    await conDbEspiada(async calls => {
        const r = await calendarSante.rescheduleAppointment('org', 'apt-1', SLOT, { servicio: 'X' });
        assert.strictEqual(r.success, false);
        assert.strictEqual(r.reason, 'duracion_invalida');
        assert.strictEqual(calls.update.length, 0);
        // Y 'duracion_invalida' no es 'not_found': el fallback a INSERT de bot.js solo
        // reacciona a 'not_found', así que esto no puede acabar creando una cita nueva.
        assert.notStrictEqual(r.reason, 'not_found');
    });
});

// ─── Regresión de fuente ─────────────────────────────────────────────────────

test('las dos escrituras de ends_at ya no llevan `duracion || 60`', () => {
    const BOT = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    const CAL = fs.readFileSync(path.join(__dirname, '..', 'services', 'calendar-sante.js'), 'utf8');
    // Solo las DOS que acaban en ends_at (creación y ampliación). El filtro de anclas,
    // el guard de cierre y el precio del mensaje tienen sus propios `|| 60` y no
    // escriben en la agenda: se tratan aparte.
    assert.ok(!/const\s+total(Duration|Dur)\s*=[^;]*\|\|\s*60/.test(BOT),
        'la duración de la cita se resuelve con resolveAppointmentDurationMin, no con un || 60');
    assert.ok(/const\s+totalDuration\s*=\s*durPrincipal\.minutos/.test(BOT), 'creación de la cita');
    assert.ok(/const\s+totalDur\s*=\s*durPrincipal\.minutos/.test(BOT), 'ampliación por upselling');
    assert.ok(!/duracionMin:\s*duracionMin\s*\|\|/.test(CAL),
        'calendar-sante no rescata una duración ausente: la rechaza');
    assert.strictEqual((CAL.match(/assertDuracion\(/g) || []).length, 3,
        'la aserción de duración cubre bookAppointment y rescheduleAppointment (+ su definición)');
});

console.log('Tests de duración de ends_at OK');
