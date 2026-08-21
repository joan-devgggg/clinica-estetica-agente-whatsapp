/**
 * tests/escalera-telemetria.test.js — la escritura que NO puede romper nada (migración 044).
 *
 * `registrarIntervencionEscalera` es la única escritura del sistema cuyo fallo no significa
 * nada para la clienta: perder una fila de telemetría no puede costar un turno. Por eso es
 * la única que se salta `assertWrite`, y por eso hace falta un fichero que fije ESE contrato
 * — si algún día alguien la "arregla" para que lance como las demás, un fallo de Supabase
 * pasaría a tumbar la conversación que estaba midiendo. Instrumentar no puede romper lo
 * instrumentado.
 *
 * Y el caso que de verdad va a ocurrir: la 044 se enseña ANTES de aplicarse (regla 6), así
 * que entre el push y la migración hay una ventana en la que la tabla NO EXISTE. Durante esa
 * ventana el bot tiene que funcionar exactamente igual y avisar UNA vez, no una por
 * intervención — un error idéntico repetido en el log de producción es cómo se tapa lo que
 * sí importa.
 *
 * Sabotajes MEDIDOS (cp previo, 20/08/2026):
 *   · que lance como cualquier otra escritura del fichero (throw en vez de return false) .. 4 rojos
 *   · quitar la guarda `_avisadoEscaleraSinTabla` (un aviso por intervención) ........... 1 rojo
 *   · quitar la guarda del arnés (21/08/2026) ......................................... 2 rojos
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const { SANTE_ORG_ID } = require('../services/org-registry');

// ─── Supabase de mentira: solo hace falta `.from(t).insert(p)` ───────────────
let respuesta = { error: null };
let lanza = null;
const inserts = [];
const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: {
        from(tabla) {
            return {
                insert(payload) {
                    if (lanza) return Promise.reject(new Error(lanza));
                    inserts.push({ tabla, payload });
                    return Promise.resolve(respuesta);
                },
            };
        },
    },
};

const logs = [];
const rec = level => (evento, campos = {}) => { logs.push({ level, evento, ...campos }); };
const loggerPath = require.resolve('../lib/logger');
require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') },
};

const db = require('../services/db');

const DATOS = {
    telefono: '34600111222',
    clase: 'agenda',
    red: 'respondsWithInventedDates',
    peldano: 'sustituir',
    motivo: 'regen_timing_sin_servicio',
    latenciaRegenMs: 2694,
    respuestaOriginal: 'Genial. ¿Te va mejor el sábado 22 o el sábado 29 de agosto?',
    respuestaFinal: 'Para mirarte los huecos primero necesito saber qué servicio quieres 😊',
    tieneServicio: false,
    huecosCargados: 0,
    sinServicioStreak: 1,
    idioma: 'es',
};

function reset() {
    respuesta = { error: null };
    lanza = null;
    inserts.length = 0;
    logs.length = 0;
    db._resetAvisoEscaleraSinTabla();
}

// ─── 1 · Lo que escribe ──────────────────────────────────────────────────────

test('la fila lleva las dos mitades: qué pasó y con qué contexto', async () => {
    reset();
    assert.strictEqual(await db.registrarIntervencionEscalera(SANTE_ORG_ID, DATOS), true);
    assert.strictEqual(inserts.length, 1);
    assert.strictEqual(inserts[0].tabla, 'escalera_intervenciones');
    const p = inserts[0].payload;
    assert.strictEqual(p.organization_id, SANTE_ORG_ID);
    assert.strictEqual(p.red, 'respondsWithInventedDates');
    assert.strictEqual(p.peldano, 'sustituir');
    assert.strictEqual(p.motivo, 'regen_timing_sin_servicio');
    assert.strictEqual(p.respuesta_original, DATOS.respuestaOriginal, 'sin el texto comido no hay nada que juzgar');
    assert.strictEqual(p.respuesta_final, DATOS.respuestaFinal);
    assert.strictEqual(p.tiene_servicio, false);
    assert.strictEqual(p.huecos_cargados, 0);
    assert.strictEqual(p.latencia_regen_ms, 2694);
    assert.strictEqual(p.telefono, '34600111222');
    assert.strictEqual(p.salida, null, 'la escribirá la tanda del embudo');
});

test('lo que no se sabe va a NULL, nunca a un valor plausible', async () => {
    reset();
    await db.registrarIntervencionEscalera(SANTE_ORG_ID, { red: 'x', peldano: 'sustituir' });
    const p = inserts[0].payload;
    // Un 0 en huecos_cargados significa «la agenda estaba vacía» y un false en
    // tiene_servicio significa «no había servicio elegido»: los dos son AFIRMACIONES. Si el
    // llamador no los manda, inventarlos convertiría un hueco de datos en una medición.
    assert.strictEqual(p.huecos_cargados, null);
    assert.strictEqual(p.tiene_servicio, null);
    assert.strictEqual(p.sin_servicio_streak, null);
    assert.strictEqual(p.latencia_regen_ms, null, 'un 0 diría que el modelo contestó al instante');
    assert.strictEqual(p.clase, 'agenda', 'la clase sí tiene un default: hoy solo existe una');
});

// ─── 2 · Lo que NO puede hacer ───────────────────────────────────────────────

test('un error de Supabase NO lanza: devuelve false y lo deja logueado', async () => {
    reset();
    respuesta = { error: { message: 'permission denied', code: '42501' } };
    const r = await db.registrarIntervencionEscalera(SANTE_ORG_ID, DATOS);
    assert.strictEqual(r, false, 'esta escritura NO usa assertWrite: medir no puede romper lo medido');
    assert.ok(logs.some(l => l.evento === 'escalera_telemetria_no_escrita'), 'pero tampoco es un silencio');
});

test('una excepción de la librería tampoco escapa', async () => {
    reset();
    lanza = 'socket hang up';
    await assert.doesNotReject(() => db.registrarIntervencionEscalera(SANTE_ORG_ID, DATOS));
    assert.strictEqual(await db.registrarIntervencionEscalera(SANTE_ORG_ID, DATOS), false);
});

// ─── 3 · La ventana entre el push y la migración ─────────────────────────────

test('sin la tabla creada, el aviso sale UNA vez por proceso y luego se calla', async () => {
    reset();
    respuesta = { error: { message: 'relation "escalera_intervenciones" does not exist', code: '42P01' } };
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(await db.registrarIntervencionEscalera(SANTE_ORG_ID, DATOS), false);
    }
    const avisos = logs.filter(l => l.evento === 'escalera_telemetria_sin_tabla');
    assert.strictEqual(avisos.length, 1,
        `cinco intervenciones sin la 044 aplicada tienen que dejar UN aviso, no cinco (salieron ${avisos.length})`);
    assert.ok(/044/.test(JSON.stringify(avisos[0])), 'el aviso tiene que decir qué migración falta');
    assert.strictEqual(logs.filter(l => l.evento === 'escalera_telemetria_no_escrita').length, 0,
        'una tabla que aún no existe es el estado ESPERADO, no un error que perseguir');
});

test('un error DISTINTO sí se loguea cada vez: no lo tapa la guarda del aviso', async () => {
    // El riesgo de la guarda de arriba es que se coma también los fallos de verdad. Aquí se
    // afirma que no: la guarda es solo para 42P01.
    reset();
    respuesta = { error: { message: 'permission denied', code: '42501' } };
    await db.registrarIntervencionEscalera(SANTE_ORG_ID, DATOS);
    await db.registrarIntervencionEscalera(SANTE_ORG_ID, DATOS);
    assert.strictEqual(logs.filter(l => l.evento === 'escalera_telemetria_no_escrita').length, 2);
});

// ─── 4 · El arnés no escribe en la telemetría de producción ──────────────────

test('REGRESIÓN · una conversación del ARNÉS no deja fila', async () => {
    // Las TRES primeras filas de la 044 eran del arnés y las cero restantes de nadie.
    // `verify:robustez:llm` conduce contra la Supabase REAL —es lo que le da valor— así que
    // sus intervenciones aterrizaban en la misma tabla que se consulta para decidir si el
    // embudo dispara demasiado.
    reset();
    for (const tel of ['9996001009', '9996001010', '9996001027', '999123456789']) {
        assert.strictEqual(await db.registrarIntervencionEscalera(SANTE_ORG_ID, { ...DATOS, telefono: tel }), false,
            `${tel} es del arnés: no puede escribir`);
    }
    assert.strictEqual(inserts.length, 0, `el arnés escribió ${inserts.length} filas en producción`);
});

test('CONTROL · una conversación real sigue escribiendo, y una sin teléfono también', async () => {
    reset();
    await db.registrarIntervencionEscalera(SANTE_ORG_ID, { ...DATOS, telefono: '34600111222' });
    await db.registrarIntervencionEscalera(SANTE_ORG_ID, { ...DATOS, telefono: '380509321253' });
    // Sin teléfono NO se descarta: es una intervención real cuya fila se pierde si se filtra.
    await db.registrarIntervencionEscalera(SANTE_ORG_ID, { ...DATOS, telefono: null });
    assert.strictEqual(inserts.length, 3, 'las tres tienen que escribirse');
});

test('el criterio es el MISMO que excluye al arnés de las campañas', async () => {
    // Una segunda lista de prefijos aquí se separaría de la de helpers en el primer cambio,
    // y entonces el arnés volvería a ensuciar la tabla sin que nada lo dijera.
    const { motivoNoEnviable } = require('../services/helpers');
    assert.strictEqual(motivoNoEnviable('9996001009'), 'prueba');
    assert.strictEqual(motivoNoEnviable('34600111222'), null);
    const src = require('fs').readFileSync(require.resolve('../services/db.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function registrarIntervencionEscalera'));
    assert.ok(/motivoNoEnviable/.test(fn.slice(0, 400)),
        'la guarda tiene que salir de motivoNoEnviable, no de un prefijo escrito aquí');
});
