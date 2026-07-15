// Regresión: el upselling NO debe ofrecerse si la cita ampliada cruza el cierre.
// Bug real: Mechas Contouring (200 min) a las 15:00 + upsell de reconstrucción
// terminaba pasado el cierre de las 19:00, pero el guard lo dejó pasar porque la
// ETIQUETA de marketing del upsell ("Reconstrucción molecular K18 o Pro-Miracle")
// no casaba por nombre exacto contra el catálogo → duración caía al fallback de 30
// min → 15:00 + 200 + 30 = 18:50 (falso "cabe"). Con la duración real (60) da 19:20.
// Partes DETERMINISTAS, sin WhatsApp/LLM/Supabase.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { resolveServiceDurationMin, shouldDiscardUpsellForClosing } = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Catálogo real (subconjunto) de Sante.
const CATALOG = [
    { nombre: 'Mechas Contouring', precio: 160, duracion: 200, categoria: 'Mechas Contouring' },
    { nombre: 'K18', precio: 45, duracion: 60, categoria: 'Reconstrucción' },
    { nombre: 'Pro Miracle Repair TEMPTING', precio: 65, duracion: 60, categoria: 'Reconstrucción' },
    { nombre: 'Miracle Elixir', precio: 59, duracion: 60, categoria: 'Tratamiento Orgánico' },
];
// Etiqueta EXACTA que devuelve matchUpsellSuggestion para "Mechas" (regla real en DB).
const UPSELL_LABEL = 'Reconstrucción molecular K18 o Pro-Miracle';

// ─── resolveServiceDurationMin ────────────────────────────────────────────────
test('resolveServiceDurationMin: etiqueta de marketing resuelve a la duración REAL (60), no al fallback 30', () => {
    assert.strictEqual(resolveServiceDurationMin(UPSELL_LABEL, CATALOG), 60);
});

test('resolveServiceDurationMin: nombre exacto de catálogo resuelve a su duración', () => {
    assert.strictEqual(resolveServiceDurationMin('K18', CATALOG), 60);
    assert.strictEqual(resolveServiceDurationMin('Mechas Contouring', CATALOG), 200);
});

test('resolveServiceDurationMin: etiqueta irresoluble cae a un fallback CONSERVADOR de 60 (no 30)', () => {
    assert.strictEqual(resolveServiceDurationMin('Servicio inventado xyz', CATALOG), 60);
});

// ─── Guard anti-cierre ────────────────────────────────────────────────────────
test('BUG REPRODUCIDO: Mechas Contouring 200 min a las 15:00 + upsell K18/Pro-Miracle → NO ofrecer (tope 19:00)', () => {
    const r = shouldDiscardUpsellForClosing({
        horaCita: '15:00',
        serviceDurMin: 200,
        upsellLabel: UPSELL_LABEL,
        catalog: CATALOG,
    });
    assert.strictEqual(r.discard, true, 'debe descartarse: 15:00 + 200 + 60 = 19:20 > 19:00');
    assert.strictEqual(r.motivo, 'tope_19h');
    assert.strictEqual(r.apptEnd, 19 * 60 + 20); // 19:20
});

test('CONTROL: servicio que termina a las 17:00 + upsell 60 min → SÍ ofrecer (termina 18:00)', () => {
    const r = shouldDiscardUpsellForClosing({
        horaCita: '15:00',
        serviceDurMin: 120,
        upsellLabel: UPSELL_LABEL,
        catalog: CATALOG,
    });
    assert.strictEqual(r.discard, false, '15:00 + 120 + 60 = 18:00 ≤ 19:00');
    assert.strictEqual(r.apptEnd, 18 * 60);
});

test('LÍMITE: la cita ampliada termina EXACTAMENTE a las 19:00 → SÍ ofrecer (no cruza el cierre)', () => {
    const r = shouldDiscardUpsellForClosing({
        horaCita: '16:00',
        serviceDurMin: 120,
        upsellLabel: UPSELL_LABEL,
        catalog: CATALOG,
    });
    assert.strictEqual(r.discard, false, '16:00 + 120 + 60 = 19:00 == cierre, permitido');
    assert.strictEqual(r.apptEnd, 19 * 60);
});

test('CIERRE ESTILISTA: upsell que termina 18:20 con cierre de estilista a las 18:00 → NO ofrecer', () => {
    const r = shouldDiscardUpsellForClosing({
        horaCita: '16:20',
        serviceDurMin: 60,
        upsellLabel: UPSELL_LABEL, // 60 min → 16:20 + 60 + 60 = 18:20 (bajo el tope 19:00, sobre el cierre 18:00)
        catalog: CATALOG,
        stylistCloseMin: 18 * 60, // cierre 18:00
    });
    assert.strictEqual(r.discard, true);
    assert.strictEqual(r.motivo, 'cierre_estilista');
});

test('hora_cita ausente/malformada → no descarta (guard delega en el resto de la lógica)', () => {
    const r = shouldDiscardUpsellForClosing({
        horaCita: undefined,
        serviceDurMin: 200,
        upsellLabel: UPSELL_LABEL,
        catalog: CATALOG,
    });
    assert.strictEqual(r.discard, false);
    assert.strictEqual(r.apptEnd, null);
});
