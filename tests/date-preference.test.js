// Regresión del subsistema de preferencia de fecha/hora del salón.
// Fija el reducer ÚNICO e idempotente (services/date-preference.js) + el extractor de señal
// (extractDateSignalSante) que reemplazan el manejo disperso anterior (session.weekPreference
// + resolveStickyWeek + merges condicionales). Objetivo central: matar la clase de deriva
// "martes 21 → martes 28" — repetir/typear la petición NUNCA debe desplazar la semana.
//
// Puro y hermético: solo aritmética de fechas (date-utils), sin red ni BD. Fake creds Supabase
// por si algún require transitivo las mira; TZ fija para fechas deterministas.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { applyDatePreference } = require('../services/date-preference');
const { extractDateSignalSante, extractQuickDataSante } = require('../services/helpers');
const { mondayDow } = require('../services/date-utils');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// new Date() → instante fijo; con args → Date real. HOY = lunes 13/07/2026:
//   esta semana = lun 13 .. dom 19 ; próxima semana = lun 20 .. dom 26.
//   martes(1) próxima = 21 ; miércoles(2) próxima = 22 ; jueves(3) próxima = 23.
const LUNES = '2026-07-13T09:00:00Z';
function withNow(iso, fn) {
    const R = Date;
    class M extends R { constructor(...a) { if (!a.length) { super(iso); return; } super(...a); } static now() { return new R(iso).getTime(); } }
    global.Date = M;
    try { return fn(); } finally { global.Date = R; }
}
// Aplica una señal (objeto o texto → señal) sobre un estado y devuelve el nuevo estado.
function apply(state, signalOrText) {
    const signal = typeof signalOrText === 'string' ? extractDateSignalSante(signalOrText) : signalOrText;
    return applyDatePreference(state, signal, new Date());
}

// ─── IDEMPOTENCIA (el corazón del fix) ────────────────────────────────────────
test('idempotencia: aplicar la MISMA señal 2× no cambia el estado (typo que repite)', () => {
    withNow(LUNES, () => {
        const s1 = apply({}, 'martes de la semana siguiente');
        assert.strictEqual(s1.fecha, '2026-07-21', 'colapsa a la fecha del martes próximo');
        const s2 = apply(s1, 'martes de la semana siguiente');
        assert.deepStrictEqual(s2, s1, 'repetir el turno da EXACTAMENTE el mismo estado');
        const s3 = apply(s2, 'martes de la semana siguiente');
        assert.strictEqual(s3.fecha, '2026-07-21', 'sigue siendo el 21, jamás deriva al 28');
    });
});

test('idempotencia: "el martes" pelado tras un martes ya resuelto no desplaza la semana', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'martes de la semana siguiente'); // {fecha:21, semana:siguiente}
        s = apply(s, 'el martes'); // sin palabra de semana → hereda contexto
        assert.strictEqual(s.fecha, '2026-07-21', 'el contexto de semana heredado mantiene el 21');
    });
});

// ─── COLAPSO día+semana → fecha ────────────────────────────────────────────────
test('colapso en turnos separados: "semana que viene" luego "el martes" → fecha del 21', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'la semana que viene');
        assert.deepStrictEqual(s, { semana: 'siguiente' }, 'sin día todavía, solo recuerda la semana');
        s = apply(s, 'el martes');
        assert.strictEqual(s.fecha, '2026-07-21');
        assert.strictEqual(s.diaSemana, undefined, 'diaSemana se consume en la fecha');
    });
});

test('colapso en un solo turno: "el martes de la semana siguiente" → fecha del 21', () => {
    withNow(LUNES, () => {
        assert.strictEqual(apply({}, 'el martes de la semana siguiente').fecha, '2026-07-21');
    });
});

test('contexto de semana se conserva al cambiar de día ("mejor el miércoles")', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'martes de la semana siguiente'); // 21
        s = apply(s, 'mejor el miercoles');
        assert.strictEqual(s.fecha, '2026-07-22', 'miércoles de la MISMA semana pedida (próxima)');
    });
});

// ─── CORRECCIONES (mismo y distinto turno) ─────────────────────────────────────
test('corrección de día con contexto: martes → jueves gana jueves', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'la semana que viene');
        s = apply(s, 'el martes');   // 21
        s = apply(s, 'el jueves');   // 23 (hereda 'siguiente')
        assert.strictEqual(s.fecha, '2026-07-23');
    });
});

test('corrección fecha → asap FUERTE limpia la fecha', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'el 24 de julio');
        assert.ok(s.fecha);
        s = apply(s, 'lo antes posible');
        assert.deepStrictEqual(s, { asap: true }, 'asap fuerte borra fecha/día/semana');
    });
});

test('corrección asap → fecha concreta gana la fecha', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'lo antes posible');
        assert.strictEqual(s.asap, true);
        s = apply(s, 'el 24 de julio');
        assert.strictEqual(s.asap, undefined, 'la fecha cancela asap');
        assert.ok(s.fecha);
    });
});

// ─── ASAP FUERTE vs DÉBIL (bug de producción del 28/07) ────────────────────────
test('asap DÉBIL ("el más cercano") NO borra el día que la clienta acaba de pedir', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'el sabado');
        assert.strictEqual(s.diaSemana, 5);
        s = apply(s, 'el mas cercano');
        assert.strictEqual(s.diaSemana, 5, 'el sábado sobrevive (root cause de la conv. de Eva)');
        assert.strictEqual(s.asap, true, 'pero la búsqueda arranca desde ya');
    });
});

test('asap DÉBIL sí suelta el filtro de SEMANA (que es el que sobra-acota)', () => {
    withNow(LUNES, () => {
        const s = apply({ semana: 'siguiente' }, 'el mas cercano');
        assert.strictEqual(s.semana, undefined);
        assert.strictEqual(s.asap, true);
    });
});

test('un día en el MISMO mensaje manda sobre el asap débil', () => {
    withNow(LUNES, () => {
        const s = apply({}, 'el jueves, cualquiera me vale');
        assert.strictEqual(s.diaSemana, 3, 'el jueves gana');
        assert.strictEqual(s.asap, undefined, 'y cancela el asap débil');
    });
});

test('fecha ABSOLUTA determina la semana por sí sola: borra un contexto de semana previo', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'la semana que viene'); // {semana:siguiente}
        s = apply(s, 'el 14 de julio');           // fecha de ESTA semana
        assert.strictEqual(s.fecha, '2026-07-14');
        assert.strictEqual(s.semana, undefined, 'no arrastra siguiente sobre una fecha absoluta');
    });
});

// ─── ORTOGONALIDAD del periodo ─────────────────────────────────────────────────
test('periodo (mañana/tarde) no toca el ancla de fecha', () => {
    withNow(LUNES, () => {
        let s = apply({}, 'martes de la semana siguiente'); // {fecha:21, semana:siguiente}
        s = apply(s, 'por la tarde');
        assert.strictEqual(s.fecha, '2026-07-21', 'la fecha sigue intacta');
        assert.strictEqual(s.periodo, 'tarde');
    });
});

// ─── PARSER (hueco cerrado) ────────────────────────────────────────────────────
test('parser: variantes de fecha resuelven a fecha ("21 julio", "martes 21", "el 21", "21 de julio")', () => {
    withNow(LUNES, () => {
        for (const txt of ['21 julio', 'martes 21', 'el 21', '21 de julio']) {
            assert.strictEqual(extractDateSignalSante(txt).fecha, '2026-07-21', `"${txt}" debe resolver fecha`);
        }
    });
});

test('parser: número de HORA junto a un día NO se toma como día del mes ("el martes a las 11")', () => {
    const sig = extractDateSignalSante('el martes a las 11');
    assert.strictEqual(sig.diaSemana, 1, 'detecta el martes');
    assert.strictEqual(sig.fecha, undefined, 'las 11 es hora, no día del mes');
});

test('parser: "el martes que viene" → día + semana siguiente (resuelve al 21)', () => {
    withNow(LUNES, () => {
        assert.strictEqual(apply({}, 'el martes que viene').fecha, '2026-07-21');
    });
});

// ─── HERENCIA LIMPIA / combos en cualquier orden ───────────────────────────────
test('un semana viejo NO sobrevive a una fecha nueva ni a asap', () => {
    withNow(LUNES, () => {
        assert.strictEqual(apply({ semana: 'siguiente' }, 'el 24 de julio').semana, undefined);
        assert.strictEqual(apply({ semana: 'siguiente', fecha: '2026-07-21' }, 'lo antes posible').semana, undefined);
    });
});

test('matriz de orden: semana → periodo → día produce el mismo colapso que día directo', () => {
    withNow(LUNES, () => {
        const a = apply(apply(apply({}, 'la semana que viene'), 'por la tarde'), 'el martes');
        assert.strictEqual(a.fecha, '2026-07-21');
        assert.strictEqual(a.periodo, 'tarde');
    });
});

test("'esta' con el día ya pasado se conserva como combo (el motor decide), no inventa fecha", () => {
    withNow(LUNES, () => {
        // Hoy es lunes; "este lunes por la mañana" pero la búsqueda arranca mañana → el lunes
        // ya no cabe esta semana → sin fecha resuelta, se conserva {diaSemana, semana}.
        const s = applyDatePreference({}, { diaSemana: 0, semana: 'esta' }, new Date());
        assert.strictEqual(s.fecha, undefined);
        assert.strictEqual(s.diaSemana, 0);
        assert.strictEqual(s.semana, 'esta');
    });
});

// ─── Coherencia con la resolución de fecha ─────────────────────────────────────
test('la fecha resuelta cae en el día de la semana pedido', () => {
    withNow(LUNES, () => {
        assert.strictEqual(mondayDow(apply({}, 'martes de la semana siguiente').fecha), 1);
        assert.strictEqual(mondayDow(apply({}, 'jueves que viene').fecha), 3);
    });
});

// ─── Integración fina con extractQuickDataSante (mismo store) ──────────────────
test('extractQuickDataSante escribe el resultado del reducer en preferencia_horaria', () => {
    withNow(LUNES, () => {
        const pd = extractQuickDataSante('quiero cita el martes de la semana que viene', {});
        assert.strictEqual(pd.preferencia_horaria.fecha, '2026-07-21');
    });
});

// ─── P1: typos de "que viene" SIN espacio no deben romper la señal de semana ────
// Root cause del bug real (jueves 16/07): "de la semana queviene" perdía `semana` y dejaba un
// diaSemana pelado → el motor caía a la ocurrencia más cercana y el LLM verbalizaba mal. El
// extractor debe tolerar "queviene"/"q viene"/"qviene"/"que  viene" igual que "que viene".
test("'queviene' y variantes sin espacio resuelven la semana como 'que viene'", () => {
    withNow(LUNES, () => {
        assert.strictEqual(apply({}, 'el martes de la semana que viene').fecha, '2026-07-21', 'baseline');
        for (const frase of [
            'el martes de la semana queviene',
            'el martes de la semana q viene',
            'el martes de la semana qviene',
            'el martes de la semana que  viene',
            'quiero el martes de la semana queviene, no me importa la estilista',
        ]) {
            const s = apply({}, frase);
            assert.strictEqual(s.semana, 'siguiente', `"${frase}" → semana 'siguiente'`);
            assert.strictEqual(s.fecha, '2026-07-21', `"${frase}" → colapsa al martes 21`);
            assert.strictEqual(s.diaSemana, undefined, `"${frase}" → sin diaSemana suelto`);
        }
    });
});

if (!process.exitCode) console.log('\nTodos los tests de date-preference OK');
