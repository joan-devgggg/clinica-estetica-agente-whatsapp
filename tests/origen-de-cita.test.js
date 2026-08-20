/**
 * tests/origen-de-cita.test.js — de dónde viene una cita, dicho como lo diría la dueña.
 *
 * `appointments.source` guarda 'web' | 'bot' | 'manual' desde la migración 005 y hasta el
 * 21/08/2026 no se pintaba en NINGUNA pantalla: una reserva del enlace era indistinguible de
 * una que había tecleado una estilista. El dato estaba; faltaba enseñarlo.
 *
 * Las dos mitades que este fichero ata, y que por separado no valen:
 *
 *   1. EL VOCABULARIO — `lib/origen-cita.ts`, un fichero sin dependencias que se ejecuta
 *      desde Node (mismo truco que service-names.ts). Tres etiquetas, y `null` para todo lo
 *      demás: una cita sin dato no se etiqueta a ojo.
 *   2. LA PARIDAD — que esas tres sean EXACTAMENTE los valores que el backend escribe. Con
 *      la tabla suelta, añadir mañana un `source: 'importado'` dejaría esas citas sin
 *      etiqueta y nadie se enteraría: la pantalla no se rompe, simplemente calla.
 *
 * ── Sabotajes medidos (21/08/2026) ───────────────────────────────────────────────────────
 *   · que un `source` desconocido caiga en «A mano» en vez de en nada ............ 2 rojos
 *   · quitarle la etiqueta a 'web' (un valor que el backend sí escribe) .......... 2 rojos
 *   · que la proyección de db.js deje de mandar `origen_cita` .................... 1 rojo
 *   · confundir `origen` (de la ficha) con `origen_cita` (de la cita) ............ 1 rojo
 *   · borrar el distintivo de la tarjeta de Reservas ............................. 1 rojo
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const leer = (...t) => fs.readFileSync(path.join(RAIZ, ...t), 'utf8');
const M = require(path.join(RAIZ, 'dashboard-app', 'src', 'lib', 'origen-cita.ts'));

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// ─── 1 · El vocabulario ──────────────────────────────────────────────────────────────────

test('las tres etiquetas están en el idioma de la dueña, no en el nuestro', () => {
    const crudos = ['source', 'web', 'bot', 'manual', 'origen_cita'];
    for (const clave of M.ORIGENES_CONOCIDOS) {
        const e = M.origenDeCita(clave);
        assert.ok(e.corta && e.frase, `${clave} sin texto`);
        for (const crudo of crudos) {
            assert.ok(!e.corta.toLowerCase().split(/\W+/).includes(crudo),
                `${clave}: «${e.corta}» le enseña a la dueña nuestro vocabulario`);
            assert.ok(!e.frase.toLowerCase().split(/\W+/).includes(crudo),
                `${clave}: «${e.frase}» le enseña a la dueña nuestro vocabulario`);
        }
    }
    assert.strictEqual(M.origenDeCita('web').corta, 'Por internet');
    assert.strictEqual(M.origenDeCita('bot').corta, 'Por WhatsApp');
    assert.strictEqual(M.origenDeCita('manual').corta, 'A mano');
});

test('las tres se distinguen entre sí: ni un texto repetido', () => {
    const cortas = M.ORIGENES_CONOCIDOS.map(k => M.origenDeCita(k).corta);
    const frases = M.ORIGENES_CONOCIDOS.map(k => M.origenDeCita(k).frase);
    const iconos = M.ORIGENES_CONOCIDOS.map(k => M.origenDeCita(k).icono);
    assert.strictEqual(new Set(cortas).size, 3, `dos orígenes con el mismo distintivo: ${cortas}`);
    assert.strictEqual(new Set(frases).size, 3);
    assert.strictEqual(new Set(iconos).size, 3, 'dos orígenes con el mismo dibujo no se distinguen de un vistazo');
});

test('lo que no se reconoce NO se etiqueta: mejor nada que una etiqueta falsa', () => {
    for (const malo of [null, undefined, '', '   ', 'importado', 'WEB2', 42, {}, [], 'bots']) {
        assert.strictEqual(M.origenDeCita(malo), null, `${JSON.stringify(malo)} ha salido con etiqueta`);
    }
});

test('un valor con mayúsculas o espacios sigue siendo el mismo origen', () => {
    // Nadie escribe hoy ' Web ' en esa columna, pero una etiqueta que se pierde por un
    // espacio es una cita que aparece sin origen y nadie sabe por qué.
    assert.strictEqual(M.origenDeCita(' WEB ').corta, 'Por internet');
});

test('«a mano» va APAGADO: hoy son casi todas y un distintivo en todas no distingue nada', () => {
    assert.strictEqual(M.origenDeCita('manual').tono, 'apagado');
    assert.strictEqual(M.origenDeCita('web').tono, 'destacado');
});

// ─── 2 · Paridad con lo que el backend ESCRIBE ───────────────────────────────────────────

test('las citas se crean en UN solo sitio, que es lo que hace posible el bloque siguiente', () => {
    // Si apareciera un segundo INSERT sobre appointments, la lista de orígenes de abajo
    // dejaría de ser exhaustiva sin que este fichero se enterase.
    const db = leer('services', 'db.js');
    const inserts = [...db.matchAll(/\.from\('appointments'\)\s*\n?\s*\.insert\(/g)];
    assert.strictEqual(inserts.length, 1,
        `hay ${inserts.length} INSERT sobre appointments: la lista de orígenes ya no es exhaustiva`);
});

test('todo `source` que el backend escribe tiene su etiqueta', () => {
    // Se leen los DOS ficheros que crean citas —db.js (el INSERT y su default) y webhook.js
    // (el panel y el enlace)— y se exige que cada valor literal tenga texto. bot.js queda
    // fuera a propósito: sus `source:` son campos de LOG, no la columna.
    const RE = /(?<![_\w])source:\s*(?:\w+\s*\|\|\s*)?'([a-z_]+)'/g;
    const escritos = new Set();
    for (const f of [['services', 'db.js'], ['webhook.js']]) {
        for (const m of leer(...f).matchAll(RE)) escritos.add(m[1]);
    }
    // Y el DEFAULT de la columna, que escribe Postgres cuando nadie manda nada.
    const mig = leer('supabase', 'migrations', '005_source_and_fixes.sql');
    const porDefecto = /source TEXT DEFAULT '([a-z]+)'/.exec(mig);
    assert.ok(porDefecto, 'la migración 005 ha cambiado de forma: revisa este test');
    escritos.add(porDefecto[1]);

    assert.ok(escritos.size >= 3, `solo se han encontrado ${escritos.size} orígenes: el regex ya no casa`);
    const sinEtiqueta = [...escritos].filter(v => !M.origenDeCita(v));
    assert.deepStrictEqual(sinEtiqueta, [],
        `el backend escribe ${sinEtiqueta.join(', ')} y el panel no sabe cómo llamarlo: esas citas saldrían sin origen`);
});

test('la tabla del panel no inventa orígenes que nadie escribe', () => {
    // El gemelo del anterior: texto muerto que nadie puede llegar a leer.
    assert.deepStrictEqual([...M.ORIGENES_CONOCIDOS].sort(), ['bot', 'manual', 'web']);
});

// ─── 3 · Que el dato LLEGUE y se PINTE ───────────────────────────────────────────────────
//
// React no se puede ejecutar desde aquí, así que estas tres se leen del fichero. No vigilan
// redacción: vigilan que el dato siga saliendo de la base de datos y que las tres pantallas
// sigan enseñándolo, que es literalmente lo que se pidió.

test('la proyección manda el origen de la CITA, y sin confundirlo con el de la ficha', () => {
    const db = leer('services', 'db.js');
    assert.ok(/origen_cita:\s*row\.source/.test(db),
        'la agenda del panel ha dejado de recibir el origen de la cita');
    assert.ok(/origen:\s*row\.contacts\?\.origen/.test(db),
        '`origen` (la ficha) y `origen_cita` (la cita) son dos datos distintos y los dos tienen que viajar');
});

test('las TRES pantallas lo enseñan', () => {
    const pantallas = [
        [['dashboard-app', 'src', 'components', 'reservas', 'reserva-card.tsx'], 'OrigenBadge', 'Reservas'],
        [['dashboard-app', 'src', 'components', 'agenda', 'stylist-agenda.tsx'], 'OrigenIcono', 'Agenda por estilistas'],
        [['dashboard-app', 'src', 'components', 'reservas', 'appointment-edit-sheet.tsx'], 'origenDeCita', 'Ficha de la cita'],
    ];
    for (const [ruta, marca, nombre] of pantallas) {
        const src = leer(...ruta);
        assert.ok(src.includes(marca), `${nombre} ya no enseña de dónde viene la cita`);
        assert.ok(src.includes('origen_cita'), `${nombre} no lee el campo`);
    }
});

test('San Remo se queda fuera: el distintivo está gateado por tipo de org', () => {
    // Regla de oro. El restaurante no cambia de aspecto por esto.
    const card = leer('dashboard-app', 'src', 'components', 'reservas', 'reserva-card.tsx');
    assert.ok(/isSalon\s*&&\s*<OrigenBadge/.test(card),
        'el distintivo de origen saldría también en San Remo');
});

process.exit(fallos ? 1 : 0);
