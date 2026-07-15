// Regresión: clienta RECURRENTE con estilista guardada (last_stylist/preferred) que
// pide un servicio con VARIAS estilistas elegibles (ej. Mechas Contouring → Veronika,
// Irina, Yulia). El bot DEBE preguntar "¿con tu estilista de siempre o el hueco más
// cercano?" ANTES de asignar — nunca fijar la habitual directamente.
//
// Bug real: el gating pedía correctamente (askStylistFirst=true) y NO cargaba huecos,
// pero el LLM, empujado por el contexto de clienta recurrente, devolvía
// datos.estilista_preferida = <habitual> y bot.js la fijaba (shouldFixStylistFromLlm
// sin guard) → se saltaba la pregunta. Cubrimos las dos capas deterministas:
//   1) computeStylistGating: con varias elegibles y sin preferencia → askStylistFirst.
//   2) shouldFixStylistFromLlm: mientras askStylistFirst siga activo, una estilista
//      INFERIDA por el LLM no se fija (habría sido un salto de la pregunta).
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { computeStylistGating, shouldFixStylistFromLlm } = require('../bot')._internals;

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Servicio con varias elegibles (Contouring: 3 coloristas). Clienta recurrente cuya
// última/habitual estilista es Veronika, sin haber pedido "el más cercano".
function sesionRecurrenteContouring() {
    return {
        selectedService: { nombre: 'Mechas Contouring', categoria: 'Mechas Contouring', duracion: 200 },
        selectedStylist: null,
        prefiereMasCercano: false,
        lastStylist: 'Veronika',
        preferredStylistId: 'veronika',
        askStylistFirst: false, // se recalcula con computeStylistGating
    };
}
const CONTOURING_ELEGIBLES = 3; // Veronika, Irina, Yulia

// ─── 1) Gating: varias elegibles + sin preferencia → preguntar primero ────────────
test('recurrente + varias elegibles → askStylistFirst (no busca huecos aún)', () => {
    const s = sesionRecurrenteContouring();
    const g = computeStylistGating(s, CONTOURING_ELEGIBLES);
    assert.strictEqual(g.askStylistFirst, true, 'debe preguntar la estilista antes de proponer huecos');
    assert.strictEqual(g.anyStylists, false, 'sin "el más cercano" no se busca combinado');
});

// ─── 2) Guard: mientras preguntamos, NO fijar la estilista que infiere el LLM ─────
test('recurrente: LLM infiere la habitual mientras se pregunta → NO se fija (no salta la pregunta)', () => {
    const s = sesionRecurrenteContouring();
    const g = computeStylistGating(s, CONTOURING_ELEGIBLES);
    s.askStylistFirst = g.askStylistFirst; // como hace bot.js antes de la llamada al LLM
    // El LLM devuelve datos.estilista_preferida = 'Veronika' (inferida del historial).
    assert.strictEqual(shouldFixStylistFromLlm(s), false,
        'con askStylistFirst activo, una estilista inferida por el LLM no debe fijarse');
});

// ─── 3) Cuando la clienta responde "el más cercano" → búsqueda combinada, sin pregunta ─
test('recurrente + "el más cercano" → anyStylists (no pregunta estilista)', () => {
    const s = sesionRecurrenteContouring();
    s.prefiereMasCercano = true;
    const g = computeStylistGating(s, CONTOURING_ELEGIBLES);
    assert.strictEqual(g.anyStylists, true);
    assert.strictEqual(g.askStylistFirst, false);
});

// ─── 4) Cuando la clienta nombra su estilista → ya está fijada → flujo normal ──────
// (La resolución determinista previa a la llamada del LLM habría fijado selectedStylist;
//  entonces askStylistFirst=false y el guard permite el flujo normal.)
test('estilista ya fijada por la clienta → askStylistFirst false y guard no aplica', () => {
    const s = sesionRecurrenteContouring();
    s.selectedStylist = { id: 'veronika', nombre: 'Veronika' };
    const g = computeStylistGating(s, CONTOURING_ELEGIBLES);
    assert.strictEqual(g.askStylistFirst, false, 'con estilista fijada no se vuelve a preguntar');
    // Con una estilista ya fijada, shouldFixStylistFromLlm es false (no re-fija), correcto.
    s.askStylistFirst = g.askStylistFirst;
    assert.strictEqual(shouldFixStylistFromLlm(s), false);
});

// ─── 5) Una sola elegible → se avanza sin preguntar; el LLM puede aportar estilista ─
test('una sola elegible → no pregunta; guard permite fijar (flujo normal)', () => {
    const s = sesionRecurrenteContouring();
    const g = computeStylistGating(s, 1);
    assert.strictEqual(g.askStylistFirst, false);
    assert.strictEqual(g.anyStylists, false);
    s.askStylistFirst = g.askStylistFirst;
    assert.strictEqual(shouldFixStylistFromLlm(s), true,
        'sin pregunta pendiente y sin estilista fijada, la del LLM puede fijarse');
});

// ─── 6) Sin servicio aún → nunca se pregunta estilista ni se busca combinado ───────
test('sin servicio resuelto → askStylistFirst/anyStylists false', () => {
    const s = sesionRecurrenteContouring();
    s.selectedService = null;
    const g = computeStylistGating(s, CONTOURING_ELEGIBLES);
    assert.strictEqual(g.askStylistFirst, false);
    assert.strictEqual(g.anyStylists, false);
});

// bot.js deja un setInterval (GC) que mantiene vivo el event loop: forzamos la salida.
process.exit(process.exitCode || 0);
