/**
 * tests/horizonte-y-prefetch.test.js — El horizonte es un PARÁMETRO, y el prefetch va en
 * paralelo (D7 del brief del enlace público).
 *
 * Dos cambios que viajan juntos porque el segundo solo hace falta por el primero: el enlace
 * público pide 90 días donde el bot pide 14, y a 90 días con una llamada por clic un prefetch
 * de catorce viajes ENCADENADOS deja de poder esperar.
 *
 * ── Lo que estos bloques protegen, y por qué cada uno ────────────────────────────────────
 *
 *  1. **Que el bot no se entere.** Sus dos call sites (bot.js:571 y el reload de confirmación)
 *     NO pasan `horizonteDias`, así que siguen recorriendo 14 días. El default no es una
 *     comodidad: es la garantía. Si mañana alguien "unifica" y sube el default, una
 *     conversación empezaría a ver tres meses de agenda y el prompt recibiría huecos de
 *     noviembre que su CALENDARIO DE REFERENCIA no contiene.
 *
 *  2. **Que el 14 del prompt siga siendo otro 14.** `providers/openai.js` tiene un
 *     «CALENDARIO DE REFERENCIA (próximos 14 días)» que NO es el horizonte: es una tabla de
 *     consulta para que el modelo no calcule fechas de cabeza. Subirla metería 90 líneas en
 *     cada turno de las DOS organizaciones, para siempre, y encima le invitaría a proponer
 *     fechas lejanas sin datos detrás. Aquí se afirma que los dos catorces siguen separados.
 *
 *  3. **Que el horizonte se ASERTE y no se recorte.** Un 0 recortado a 14 devolvería huecos
 *     correctos para una pregunta que nadie hizo; un 100000 recortado a 366, lo mismo al
 *     revés. Regla 3: si no se resuelve, no se inventa.
 *
 *  4. **Que el prefetch siga siendo PARALELO.** Se mide por conducta (tandas de lecturas
 *     simultáneas), no por reloj: un test de milisegundos en una máquina cualquiera es una
 *     lotería. Con el `for` en serie que había, TANDAS = 14; con Promise.all, 2.
 *
 *  5. **Que el orden lo decida el NOMBRE y no la latencia.** Es el bloque más importante de
 *     los cinco y el menos obvio: `eligible` viene ordenado por nombre y de ese orden depende
 *     quién gana cada empate en el dedupe por (fecha,hora) — la conducta que
 *     `huecos-alternativas.test.js` congela. Con las lecturas en vuelo a la vez, resolverlas
 *     por orden de llegada haría que la ganadora la eligiese la red. Aquí las estilistas
 *     responden en orden INVERSO a propósito.
 *
 * ── Medido el 20/08/2026 ─────────────────────────────────────────────────────────────────
 * Contra la Supabase real, `npm run medir:prefetch -- sante` (9 corridas, mediana):
 *
 *                              ANTES (serie)      DESPUÉS (paralelo)
 *   14 días · huecos           14 tandas 1026 ms   2 tandas  204 ms
 *   90 días · huecos           14 tandas 1149 ms   2 tandas  324 ms
 *   90 días · rejilla de mes   14 tandas 1019 ms   2 tandas  175 ms
 *
 * ── Sabotajes medidos, con los bloques que caen ──────────────────────────────────────────
 *   · el default sube de 14 a 90 (el bot se entera) .............................. 3 rojos
 *       («el default exportado es 14» + «el día 14 dentro y el 15 fuera» + «el rango…»)
 *   · el prefetch vuelve a ir en serie (D7 sin arreglar) ......................... 3 rojos
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const { test } = require('node:test');
const path = require('path');

// ─── Doble de la capa de datos ───────────────────────────────────────────────────────────
// Las cinco lecturas del motor, instrumentadas: cuentan viajes y TANDAS. Una tanda arranca
// cuando el contador de lecturas en vuelo pasa de 0 a 1; o sea, cuenta profundidad, que es
// exactamente lo que D7 mide. Cada lectura espera un macrotask real (setImmediate): sin esa
// espera, una función `async` que devuelve un array resuelve en el mismo tick y las tres
// lecturas de una estilista parecerían secuenciales aunque se hubieran lanzado juntas.
const dbPath = require.resolve(path.join(__dirname, '../services/db.js'));
let FIXTURE = {};
let IO = { viajes: 0, tandas: 0, enVuelo: 0, maxEnVuelo: 0, rangos: [] };

function resetIO() { IO = { viajes: 0, tandas: 0, enVuelo: 0, maxEnVuelo: 0, rangos: [] }; }

// `retrasoMs` deja pedir un retraso por estilista para forzar un orden de llegada concreto.
function lectura(fn) {
    return async (...args) => {
        if (IO.enVuelo === 0) IO.tandas += 1;
        IO.enVuelo += 1;
        IO.viajes += 1;
        IO.maxEnVuelo = Math.max(IO.maxEnVuelo, IO.enVuelo);
        try {
            const ms = FIXTURE.retrasoMs ? FIXTURE.retrasoMs(args) : 0;
            await new Promise(r => (ms ? setTimeout(r, ms) : setImmediate(r)));
            return fn(...args);
        } finally {
            IO.enVuelo -= 1;
        }
    };
}

require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        getStylistsByOrg: lectura(() => FIXTURE.stylists || []),
        getBlockedDays: lectura(() => FIXTURE.blockedDays || []),
        getStylistSchedule: lectura((_o, id) => (FIXTURE.schedules || {})[id] || []),
        getScheduleBlocks: lectura((_o, id, from, to) => {
            IO.rangos.push({ from, to });
            return (FIXTURE.blocks || {})[id] || [];
        }),
        getAppointmentsByStylistAndRange: lectura((_o, id, from, to) => {
            IO.rangos.push({ from, to });
            return (FIXTURE.appts || {})[id] || [];
        }),
    },
};

const { getAvailableSlots, HORIZONTE_DIAS_DEFAULT, HORIZONTE_DIAS_MAX } = require('../services/calendar-sante');

const jornadaCompleta = () => [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, start_time: '10:00', end_time: '19:00' }));

// Las cuatro generalistas reales de Sante, ya ordenadas por nombre como las entrega
// getStylistsByOrg. Todas trabajan todos los días para que el único filtro sea el horizonte.
const CUATRO = ['Irina', 'Natalia', 'Veronika', 'Yulia'].map((name, i) => ({
    id: `sty-${i + 1}`, name, active: true, skills: ['Cortes'],
}));

const hoy = new Date();
// En hora de MADRID, no UTC: entre las 00:00 y las 02:00 de Madrid toISOString() daría el
// día anterior. Mismo criterio que huecos-alternativas.test.js.
const dia = n => new Date(hoy.getTime() + n * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

function conEstilistas(stylists = CUATRO, extra = {}) {
    FIXTURE = {
        stylists,
        schedules: Object.fromEntries(stylists.map(s => [s.id, jornadaCompleta()])),
        ...extra,
    };
    resetIO();
}

const pedir = (opts = {}) => getAvailableSlots('org', { serviceDuration: 60, serviceCategory: 'Cortes', ...opts });

// ─── 1 · El default es 14, y es lo que pide el bot ───────────────────────────────────────

test('el default exportado es 14 — el número que usa el bot', () => {
    assert.strictEqual(HORIZONTE_DIAS_DEFAULT, 14);
});

test('sin horizonteDias, el día 14 está DENTRO y el 15 está fuera', async () => {
    // El recorrido arranca MAÑANA (dia(1)) y cubre 14 fechas: dia(1)…dia(14).
    conEstilistas();
    const dentro = await pedir({ preferencia: { fecha: dia(14) } });
    assert.ok(dentro.length > 0, 'el día 14 debería tener huecos: está dentro del horizonte');
    assert.ok(dentro.every(s => s.fecha === dia(14)), 'con fecha anclada solo salen huecos de ese día');

    conEstilistas();
    const fuera = await pedir({ preferencia: { fecha: dia(15) } });
    assert.ok(fuera.every(s => s.fecha !== dia(15)), 'el día 15 NO puede aparecer con el horizonte por defecto');
    assert.strictEqual(fuera.requestedDayUnavailable, true, 'y el bot tiene que enterarse de que ese día no salió');
});

test('los dos call sites del bot NO pasan horizonteDias — es lo que garantiza que no se entera', () => {
    // Un grep, sí, pero el que importa: el día que alguien le pase 90 al bot "para
    // aprovechar", esto sale en rojo y le obliga a leer el porqué en vez de descubrirlo
    // cuando el prompt reciba huecos de noviembre que su calendario no contiene.
    const bot = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8');
    const llamadas = bot.match(/calendarSante\.getAvailableSlots\(orgId, \{[\s\S]*?\n\s*\}\);/g) || [];
    assert.strictEqual(llamadas.length, 2, 'el bot tiene exactamente dos call sites del motor de huecos');
    for (const l of llamadas) {
        assert.ok(!/horizonteDias/.test(l), `un call site del bot pasa horizonteDias:\n${l}`);
    }
});

// ─── 2 · El 14 del PROMPT es otro 14 y no se mueve ───────────────────────────────────────

test('el CALENDARIO DE REFERENCIA del prompt sigue siendo de 14 días y no cuelga del motor', () => {
    const openai = fs.readFileSync(path.join(__dirname, '../services/providers/openai.js'), 'utf8');
    assert.ok(/CALENDARIO DE REFERENCIA \(próximos 14 días\)/.test(openai),
        'el encabezado del calendario de referencia ha cambiado: si se ha subido, hay que leer el porqué');
    assert.ok(/for \(let d = 0; d <= 13; d\+\+\)/.test(openai),
        'buildCalendarReference ya no recorre 14 días');
    // Y no importa el horizonte del motor: son dos decisiones distintas y tienen que poder
    // moverse por separado. 90 líneas de calendario en cada turno de las DOS orgs, para
    // siempre, es el coste de unirlas.
    // Solo el ACOPLAMIENTO: openai.js menciona calendar-sante en dos comentarios (de dónde
    // vienen los huecos y quién calcula la causa) y eso está bien. Lo que no puede es
    // importarlo ni leerle el horizonte.
    assert.ok(!/require\(['"][^'"]*calendar-sante/.test(openai),
        'el prompt ha empezado a importar el motor de huecos');
    assert.ok(!/HORIZONTE_DIAS/.test(openai),
        'el prompt ha empezado a derivar su calendario del horizonte del motor');
});

// ─── 3 · El horizonte se asierta, no se recorta ──────────────────────────────────────────

test('90 días abre el día 15, y la frontera de 90 sigue siendo una frontera', async () => {
    conEstilistas();
    const q = await pedir({ horizonteDias: 90, preferencia: { fecha: dia(15) } });
    assert.ok(q.length > 0 && q.every(s => s.fecha === dia(15)), 'con 90 días el día 15 tiene que salir');

    conEstilistas();
    const ultimo = await pedir({ horizonteDias: 90, preferencia: { fecha: dia(90) } });
    assert.ok(ultimo.length > 0, 'el día 90 es el último DENTRO (el recorrido es dia(1)…dia(90))');

    conEstilistas();
    const pasado = await pedir({ horizonteDias: 90, preferencia: { fecha: dia(91) } });
    assert.ok(pasado.every(s => s.fecha !== dia(91)), 'el día 91 queda fuera');
});

test('un horizonte imposible LANZA en vez de recortarse en silencio', async () => {
    for (const malo of [0, -1, 1.5, NaN, Infinity, HORIZONTE_DIAS_MAX + 1]) {
        conEstilistas();
        await assert.rejects(() => pedir({ horizonteDias: malo }), /horizonteDias/,
            `horizonteDias=${malo} debería lanzar, no recortarse`);
    }
});

test("una CADENA '90' también lanza: la conversión es del llamador", async () => {
    // Un query param llega como texto. Convertirlo aquí sería adivinar por él: `Number('')`
    // es 0 y `Number(true)` es 1, y los dos pasarían por horizontes plausibles. Quien lee el
    // parámetro es quien sabe qué significa que venga vacío.
    conEstilistas();
    await assert.rejects(() => pedir({ horizonteDias: '90' }), /horizonteDias/);
});

test('null y undefined caen al default, que es lo que hace el bot sin saberlo', async () => {
    conEstilistas();
    const sinNada = await pedir({ preferencia: { fecha: dia(15) } });
    conEstilistas();
    const conNull = await pedir({ horizonteDias: null, preferencia: { fecha: dia(15) } });
    assert.deepStrictEqual(conNull.map(s => s.fecha), sinNada.map(s => s.fecha));
});

test('el rango que se le pide a la BD crece con el horizonte', async () => {
    // Si el horizonte subiera solo en el bucle de días y no en el rango de la consulta, el
    // motor recorrería 90 días con las citas de solo 14: los últimos 76 saldrían LIBRES
    // aunque estuvieran cogidos. Es el fallo silencioso más caro de este cambio.
    conEstilistas();
    await pedir({});
    const corto = Math.max(...IO.rangos.map(r => new Date(r.to).getTime()));
    conEstilistas();
    await pedir({ horizonteDias: 90 });
    const largo = Math.max(...IO.rangos.map(r => new Date(r.to).getTime()));
    const diasDeMas = Math.round((largo - corto) / 86400000);
    assert.strictEqual(diasDeMas, 76, `el rango consultado solo creció ${diasDeMas} días, no 76`);
});

// ─── 4 · D7: el prefetch va en paralelo ──────────────────────────────────────────────────

test('D7: las lecturas del prefetch van en DOS tandas, no en catorce', async () => {
    conEstilistas();
    await pedir({});
    assert.strictEqual(IO.viajes, 14, 'siguen siendo 14 lecturas: lo que cambia es la profundidad, no el volumen');
    assert.strictEqual(IO.tandas, 2,
        `el prefetch volvió a encadenarse: ${IO.tandas} tandas. La primera es getStylistsByOrg (hace falta para saber a quién leer); las otras 13 van juntas.`);
    assert.strictEqual(IO.maxEnVuelo, 13, 'las 13 lecturas restantes tienen que estar en vuelo a la vez');
});

test('D7: con 90 días tampoco se encadena — el horizonte no cambia la forma del prefetch', async () => {
    conEstilistas();
    await pedir({ horizonteDias: 90 });
    assert.strictEqual(IO.tandas, 2);
});

test('D7: el abanico lo acota el EQUIPO, no el horizonte', async () => {
    // Una estilista sola son 5 lecturas (equipo + días bloqueados + sus 3), no 14: el
    // paralelismo no abre conexiones por día ni por hueco, solo por persona del equipo. Es
    // lo que hace que esto sea seguro en un endpoint público.
    conEstilistas([CUATRO[0]]);
    await pedir({ horizonteDias: 90 });
    assert.strictEqual(IO.viajes, 5);
    assert.strictEqual(IO.tandas, 2);
});

// ─── 5 · El orden lo decide el nombre, no la red ─────────────────────────────────────────

test('aunque la última estilista conteste PRIMERO, la ganadora sigue siendo la alfabética', async () => {
    // Yulia responde en 1 ms e Irina en 40: si el motor fuera resolviendo por orden de
    // llegada, el dedupe por (fecha,hora) coronaría a Yulia y la conducta que
    // huecos-alternativas.test.js congela cambiaría sin que nadie tocara una regla.
    conEstilistas(CUATRO, {
        retrasoMs: (args) => {
            const id = args[1];
            const idx = CUATRO.findIndex(s => s.id === id);
            return idx >= 0 ? (CUATRO.length - idx) * 10 : 1;
        },
    });
    const slots = await pedir({});
    assert.ok(slots.length > 0);
    assert.deepStrictEqual([...new Set(slots.map(s => s.stylistName))], ['Irina'],
        'la ganadora la ha decidido la latencia y no el nombre');
    assert.deepStrictEqual(slots[0].alternativas.map(a => a.name), ['Irina', 'Natalia', 'Veronika', 'Yulia'],
        'las alternativas también van en orden de nombre, no de llegada');
});
