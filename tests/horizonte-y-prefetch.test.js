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
 *  1. **Que haya UN horizonte y no dos.** El default es 90 desde el 20/08/2026 (antes 14) y
 *     los dos call sites del bot (bot.js:571 y el reload de confirmación) siguen SIN pasar
 *     `horizonteDias`: lo toman del default. Que no lo pasen es lo que impide que el número
 *     acabe escrito en dos sitios que hay que acordarse de mover a la vez.
 *
 *     El 14 se cambió mirando lo que costaba, no por gusto. Karolina, 17/08/2026: pidió el
 *     lunes 7 de septiembre —21 días— y el motor no llegaba, así que devolvía cero para ese
 *     día; el modelo tradujo el cero a «aún no tengo huecos cargados» y prometió avisarla
 *     cuando «cargaran» las fechas. Nunca hubo cita. Y no ahorraba nada: MAX_TOTAL (20 sin
 *     día concreto) ya acotaba la lista, así que el horizonte corto solo hacía que la mitad
 *     de septiembre no existiera.
 *
 *  2. **Que el 14 del prompt NO se haya movido con él.** `providers/openai.js` tiene un
 *     «CALENDARIO DE REFERENCIA (próximos 14 días)» que NO es el horizonte: es una tabla de
 *     consulta para que el modelo no calcule fechas de cabeza. Subirla metería 90 líneas en
 *     cada turno de las DOS organizaciones, para siempre. Ya no son «dos catorces»: son un
 *     90 y un 14, y este bloque es lo que impide que alguien los vuelva a juntar. Que el
 *     motor vea tres meses y el calendario catorce días no es una incoherencia — el modelo
 *     no tiene que resolver la fecha de un hueco lejano, `formatSlotTexto` se la da escrita;
 *     el calendario es para las palabras de la CLIENTA («este viernes»), que nunca apuntan
 *     a noviembre.
 *
 *  2 bis. **Que el bot no pueda prometer un aviso que nadie va a mandar.** No existe ningún
 *     mecanismo que escriba a una clienta cuando «carguen» fechas, y el 17/08 se lo prometió
 *     a Karolina dos veces. La regla vive en el bloque RESERVAS FUTURAS del prompt.
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
 * ── Lo que costó subir el default de 14 a 90, medido el mismo día ────────────────────────
 * Mismos 14 viajes y mismas 2 tandas; mediana 248 ms → 353 ms desde un portátil. Y el
 * bloque de HUECOS del prompt no crece ni un carácter: sin preferencia salen las MISMAS 20
 * filas y los mismos 1044 caracteres con 14 y con 90, porque el tope no es el horizonte
 * sino MAX_TOTAL. Lo que cambia es el contenido cuando se pide una fecha pasado el día 14:
 * a 21 días, de `requestedDayUnavailable` a los huecos reales de ese día.
 *
 * ── Sabotajes medidos, con los bloques que caen ──────────────────────────────────────────
 *   · el default vuelve a 14 (media agenda deja de existir) ...................... 3 rojos
 *       («el default exportado es 90» + «el día 21 dentro y el 91 fuera» + «null/undefined»)
 *   · el prefetch vuelve a ir en serie (D7 sin arreglar) ......................... 3 rojos
 *   · se borra la regla de no prometer avisos del prompt ......................... 2 rojos
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

test('el default exportado es 90 — tres meses, el número que usan el bot y el enlace', () => {
    assert.strictEqual(HORIZONTE_DIAS_DEFAULT, 90);
});

test('sin horizonteDias, el día 21 (el de Karolina) está DENTRO y el 91 está fuera', async () => {
    // El recorrido arranca MAÑANA (dia(1)) y cubre 90 fechas: dia(1)…dia(90). El 21 es el
    // que importa: es el lunes 7 de septiembre que el 17/08 no existía para el bot.
    conEstilistas();
    const dentro = await pedir({ preferencia: { fecha: dia(21) } });
    assert.ok(dentro.length > 0, 'el día 21 debería tener huecos: está dentro del horizonte');
    assert.ok(dentro.every(s => s.fecha === dia(21)), 'con fecha anclada solo salen huecos de ese día');
    assert.ok(!dentro.requestedDayUnavailable,
        'ese día SÍ está disponible: marcarlo como no disponible es lo que costó la cita de Karolina');

    conEstilistas();
    const fuera = await pedir({ preferencia: { fecha: dia(91) } });
    assert.ok(fuera.every(s => s.fecha !== dia(91)), 'el día 91 queda fuera del horizonte por defecto');
    assert.strictEqual(fuera.requestedDayUnavailable, true, 'y el bot tiene que enterarse de que ese día no salió');
});

test('los dos call sites del bot NO pasan horizonteDias — es lo que mantiene UN solo número', () => {
    // Un grep, sí, pero el que importa. Ya no protege «que el bot no se entere» (se entera:
    // el default ES su número desde el 20/08/2026); protege que el 90 esté escrito en UN
    // sitio. Un call site que lo pase a mano es un segundo número que hay que acordarse de
    // mover, y el día que no se muevan a la vez nadie lo ve desde ninguna pantalla.
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
    //
    // Los comentarios se QUITAN antes de mirar, y no es comodidad: el 20/08/2026, al subir
    // el horizonte, hizo falta explicar en un comentario de openai.js por qué el suyo NO se
    // movía —o sea, nombrar la constante para decir que no se lee— y este bloque salió en
    // rojo por la explicación. Un test que prohíbe hablar del acoplamiento en vez de
    // prohibir el acoplamiento empuja a borrar el porqué, que es lo contrario de lo que
    // este fichero existe para conseguir.
    const codigo = openai
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
    assert.ok(!/require\(['"][^'"]*calendar-sante/.test(codigo),
        'el prompt ha empezado a importar el motor de huecos');
    assert.ok(!/HORIZONTE_DIAS/.test(codigo),
        'el prompt ha empezado a derivar su calendario del horizonte del motor');
});

// ─── 2 bis · La promesa que nadie puede cumplir ──────────────────────────────────────────

// Se construye el prompt DE VERDAD en vez de grepear el fichero: así la regla tiene que
// llegar al texto que ve el modelo, no solo estar escrita en alguna parte del módulo.
const { buildSystemPrompt } = require('../services/providers/openai');
const promptSante = () => buildSystemPrompt('b2c3d4e5-f6a7-8901-bcde-f12345678901', {}, null, false, null, {
    business_info: { companyName: 'Salón de prueba', horario: 'L-S 10:00–19:00' },
    services: [], tone: 'cercano',
});

test('el prompt PROHÍBE prometer un aviso posterior — no existe quien lo mande', () => {
    // Karolina, 17/08/2026: «Déjame cargar esas fechas y te propongo opciones 😊» y «En
    // cuanto carguen los huecos de principios de septiembre te propongo las opciones». Dos
    // promesas, cero mecanismos. Escribió tres mensajes más y no le contestó nadie.
    const p = promptSante();
    assert.ok(/NUNCA PROMETAS AVISAR MÁS ADELANTE/.test(p),
        'la regla de no prometer avisos no está en el prompt');
    assert.ok(/te aviso cuando/.test(p) && /te propongo opciones/.test(p),
        'la regla tiene que ENUMERAR las frases reales que dijo el bot, no describirlas en abstracto');
});

test('el prompt PROHÍBE hablar de huecos "cargados": es maquinaria, no una respuesta', () => {
    // Misma frase, dos idiomas y diez días de diferencia: «I don't have the available slots
    // loaded for that day yet» (Michal, 07/08) y «aún no tengo huecos cargados» (Karolina,
    // 17/08). REGEN_FRASES_MAQUINARIA las enumera, pero esa lista solo mira la respuesta
    // REGENERADA por la escalera — nunca el mensaje original, que es por donde salieron las dos.
    const p = promptSante();
    assert.ok(/huecos "cargados"|huecos «cargados»/.test(p),
        'el prompt no dice nada de la jerga de "huecos cargados"');
});

test('el aviso de agenda llena ya no dice "dos semanas" ni manda a mirar "más adelante"', () => {
    // Es el texto que lee el modelo cuando el motor devuelve cero por agenda_llena. Con el
    // horizonte en 90 «las próximas dos semanas» pasa a ser falso, y «mira más adelante» es
    // peor que falso: es pedirle a la clienta algo que ya se ha hecho y no ha dado nada.
    const openai = fs.readFileSync(path.join(__dirname, '../services/providers/openai.js'), 'utf8');
    const linea = openai.split('\n').find(l => /agenda_llena:/.test(l)) || '';
    assert.ok(linea, 'no se encuentra el texto de agenda_llena');
    assert.ok(!/dos semanas/.test(linea), `agenda_llena sigue diciendo "dos semanas":\n${linea}`);
    assert.ok(/TRES MESES/.test(linea), `agenda_llena no dice el horizonte real:\n${linea}`);
    assert.ok(!/mirar más adelante/.test(linea),
        `agenda_llena sigue mandando a mirar más adelante, que ya no existe:\n${linea}`);
});

// ─── 3 · El horizonte se asierta, no se recorta ──────────────────────────────────────────

test('el parámetro sigue mandando en las DOS direcciones, y la frontera es una frontera', async () => {
    // Ahora que el default es 90, lo que hay que comprobar es que el parámetro puede
    // BAJARLO igual que antes lo subía: si dejara de hacerlo, un llamador que quisiera
    // mirar solo esta quincena estaría leyendo tres meses sin enterarse.
    conEstilistas();
    const corto = await pedir({ horizonteDias: 14, preferencia: { fecha: dia(15) } });
    assert.ok(corto.every(s => s.fecha !== dia(15)), 'con 14 explícitos el día 15 tiene que quedar fuera');
    assert.strictEqual(corto.requestedDayUnavailable, true);

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

test('null y undefined caen al default, que es de donde saca el bot sus tres meses', async () => {
    conEstilistas();
    const sinNada = await pedir({ preferencia: { fecha: dia(60) } });
    conEstilistas();
    const conNull = await pedir({ horizonteDias: null, preferencia: { fecha: dia(60) } });
    assert.deepStrictEqual(conNull.map(s => s.fecha), sinNada.map(s => s.fecha));
    // Y la fecha se elige a 60 días a propósito: con una dentro de los 14 viejos, este
    // bloque pasaría igual con el default en 14 y no diría nada del cambio.
    assert.ok(sinNada.length > 0 && sinNada.every(s => s.fecha === dia(60)),
        'sin pasar nada, el día 60 tiene que salir: el default es 90');
});

test('el rango que se le pide a la BD crece con el horizonte', async () => {
    // Si el horizonte subiera solo en el bucle de días y no en el rango de la consulta, el
    // motor recorrería 90 días con las citas de solo 14: los últimos 76 saldrían LIBRES
    // aunque estuvieran cogidos. Es el fallo silencioso más caro de este cambio.
    // Los dos horizontes van EXPLÍCITOS: comparar contra el default dejaría de medir nada
    // el día que el default valga lo mismo que el valor con el que se compara — que es
    // justo lo que pasó al subirlo a 90 (los dos lados daban 90 y el test seguía verde).
    conEstilistas();
    await pedir({ horizonteDias: 14 });
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
