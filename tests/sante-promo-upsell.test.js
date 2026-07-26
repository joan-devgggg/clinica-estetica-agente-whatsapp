// Cambios pedidos por Yulia (2026-07):
//  1) "Salida de negro" pasa a llamarse "Eliminación del pigmento" — solo texto:
//     la detección debe seguir reconociendo AMBOS nombres y devolver la misma clave
//     interna ('salida_negro'), que es la que ya está escrita en filas históricas.
//  3) Upsell de Reconstrucción tras cualquier decoloración, con tono de consejo de
//     cuidado en vez de venta.
//  4) Promo 10% primera visita a Spa Hair / Masajes tras confirmar cualquier cita.
// Todo determinista: sin WhatsApp, sin LLM, sin Supabase.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    detectConsultaService,
    matchUpsellRule,
    matchUpsellSuggestion,
    buildSanteConfirmationMessage,
    isSpaPromoCategory,
    hasPreviousSpaOrMassage,
    buildSpaPromoNote,
} = require('../services/helpers');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// Reglas reales tras la migración 018.
const UPSELL_RULES = [
    { servicio: 'Color raíz', sugerencias: ['Manicura', 'Ampolla de cuidado'] },
    { servicio: 'Mechas Balayage', sugerencias: ['Reconstrucción'], tono: 'cuidado_decoloracion' },
    { servicio: 'Mechas Airtouch', sugerencias: ['Reconstrucción'], tono: 'cuidado_decoloracion' },
    { servicio: 'Mechas Contouring', sugerencias: ['Reconstrucción'], tono: 'cuidado_decoloracion' },
    { servicio: 'Mechas clásicas', sugerencias: ['Reconstrucción'], tono: 'cuidado_decoloracion' },
    { servicio: 'Deco Total Blond', sugerencias: ['Reconstrucción'], tono: 'cuidado_decoloracion' },
    { servicio: 'Corte', sugerencias: ['Exfoliación del cuero cabelludo'] },
];

// Subconjunto real del catálogo (nombres y categorías exactos de Supabase).
const CATALOG = [
    { nombre: 'Cabello corto', precio: 180, duracion: 240, categoria: 'Mechas Balayage' },
    { nombre: 'Largo 1', precio: 195, duracion: 360, categoria: 'Mechas Airtouch' },
    { nombre: 'Largo 2', precio: 145, duracion: 120, categoria: 'Deco Total Blond' },
    { nombre: 'Mechas 2', precio: 80, duracion: 180, categoria: 'Mechas clásicas' },
    { nombre: 'Mechas Contouring', precio: 160, duracion: 200, categoria: 'Mechas Contouring' },
    { nombre: 'Reconstrucción', precio: 35, duracion: 60, categoria: 'Reconstrucción' },
    { nombre: 'Manicura + gel', precio: 35, duracion: 120, categoria: 'Manicura/Pedicura' },
    { nombre: 'Relax 45min', precio: 85, duracion: 45, categoria: 'Spa Hair' },
    { nombre: 'Deportivo', precio: 65, duracion: 60, categoria: 'Masajes y SPA' },
];

const MANICURA = CATALOG.find(s => s.nombre === 'Manicura + gel');
const BALAYAGE = CATALOG.find(s => s.categoria === 'Mechas Balayage');

// ─── Punto 1: renombrado sin romper la detección ──────────────────────────────
test('1 · detectConsultaService reconoce el nombre NUEVO y devuelve la clave interna intacta', () => {
    for (const frase of ['quiero una eliminación del pigmento', 'me pueden quitar el pigmento?', 'eliminar el pigmento del pelo']) {
        assert.deepStrictEqual(detectConsultaService(frase), { type: 'salida_negro' }, frase);
    }
});

test('1 · detectConsultaService sigue reconociendo el nombre VIEJO (las clientas lo siguen usando)', () => {
    for (const frase of ['quiero una salida de negro', 'tengo arrastre de color', 'quiero salir del negro']) {
        assert.deepStrictEqual(detectConsultaService(frase), { type: 'salida_negro' }, frase);
    }
});

test('1 · no se dispara con texto no relacionado', () => {
    assert.strictEqual(detectConsultaService('quiero un corte de pelo'), null);
});

// ─── Punto 3: upsell de reconstrucción tras cualquier decoloración ────────────
test('3 · las 5 categorías de decoloración sugieren Reconstrucción con tono de cuidado', () => {
    const decoloraciones = CATALOG.filter(s => ['Mechas Balayage', 'Mechas Airtouch', 'Deco Total Blond', 'Mechas clásicas', 'Mechas Contouring'].includes(s.categoria));
    assert.strictEqual(decoloraciones.length, 5, 'fixture incompleto');
    for (const svc of decoloraciones) {
        const rule = matchUpsellRule(svc, UPSELL_RULES);
        assert.ok(rule, `${svc.categoria} debe casar con una regla`);
        assert.strictEqual(rule.sugerencias[0], 'Reconstrucción', svc.categoria);
        assert.strictEqual(rule.tono, 'cuidado_decoloracion', svc.categoria);
    }
});

test('3 · matchUpsellSuggestion conserva su contrato (devuelve el string)', () => {
    assert.strictEqual(matchUpsellSuggestion(BALAYAGE, UPSELL_RULES), 'Reconstrucción');
    assert.strictEqual(matchUpsellSuggestion(null, UPSELL_RULES), null);
    assert.strictEqual(matchUpsellSuggestion(BALAYAGE, []), null);
});

test('3 · el mensaje usa el tono de consejo de cuidado, no el genérico de venta', () => {
    const msg = buildSanteConfirmationMessage({
        nombre: 'María', fecha: '2026-08-03', hora: '10:00',
        servicio: 'Mechas Balayage (cabello corto)', precio: 180, duracion: 240,
        categoria: 'Mechas Balayage', language: 'es',
        upsellSuggestion: 'Reconstrucción', upsellTono: 'cuidado_decoloracion',
    });
    assert.ok(/decoloraci[oó]n es un proceso agresivo/i.test(msg), 'explica por qué se aconseja');
    assert.ok(/m[aá]s fuerte/i.test(msg), 'habla del beneficio para el cabello');
    assert.ok(!/podr[ií]as aprovechar/i.test(msg), 'NO usa la plantilla genérica de venta');
});

test('3 · un upsell sin tono sigue usando la plantilla genérica de siempre', () => {
    const msg = buildSanteConfirmationMessage({
        nombre: 'María', fecha: '2026-08-03', hora: '10:00',
        servicio: 'Corte mujer y secado', precio: 40, duracion: 45,
        categoria: 'Cortes', language: 'es',
        upsellSuggestion: 'Exfoliación del cuero cabelludo',
    });
    assert.ok(/podr[ií]as aprovechar/i.test(msg), 'plantilla genérica intacta');
    assert.ok(!/decoloraci[oó]n/i.test(msg));
});

// ─── Punto 4: promo 10% primera visita Spa Hair / Masajes ─────────────────────
test('4 · isSpaPromoCategory solo cubre Spa Hair y Masajes y SPA', () => {
    assert.strictEqual(isSpaPromoCategory('Spa Hair'), true);
    assert.strictEqual(isSpaPromoCategory('Masajes y SPA'), true);
    assert.strictEqual(isSpaPromoCategory('masajes y spa'), true);
    assert.strictEqual(isSpaPromoCategory('Manicura/Pedicura'), false);
    assert.strictEqual(isSpaPromoCategory(null), false);
});

test('4 · hasPreviousSpaOrMassage detecta el historial por nombre de variante', () => {
    // appointments.service guarda el nombre de la variante, no la categoría.
    assert.strictEqual(hasPreviousSpaOrMassage(['Relax 45min'], CATALOG), true);
    assert.strictEqual(hasPreviousSpaOrMassage(['Deportivo'], CATALOG), true);
    // También si vino fusionado con un upsell.
    assert.strictEqual(hasPreviousSpaOrMassage(['Corte mujer y secado + Deportivo'], CATALOG), true);
    assert.strictEqual(hasPreviousSpaOrMassage(['Manicura + gel', 'Corte hombre'], CATALOG), false);
    assert.strictEqual(hasPreviousSpaOrMassage([], CATALOG), false);
});

test('4 · el mensaje menciona la promo cuando aplica', () => {
    const msg = buildSanteConfirmationMessage({
        nombre: 'María', fecha: '2026-08-03', hora: '11:00',
        servicio: 'Manicura + gel', precio: 35, duracion: 120,
        categoria: 'Manicura/Pedicura', language: 'es', spaPromo: true,
    });
    assert.ok(/Spa Hair/i.test(msg) && /Masajes/i.test(msg), 'nombra los dos servicios nuevos');
    assert.ok(/10\s*%/.test(msg), 'menciona el 10%');
    assert.ok(/primera visita/i.test(msg), 'deja claro que es solo la primera visita');
});

test('4 · sin promo el mensaje queda exactamente como antes', () => {
    const args = {
        nombre: 'María', fecha: '2026-08-03', hora: '11:00',
        servicio: 'Manicura + gel', precio: 35, duracion: 120,
        categoria: 'Manicura/Pedicura', language: 'es',
    };
    const sinPromo = buildSanteConfirmationMessage(args);
    assert.ok(!/Spa Hair/i.test(sinPromo));
    assert.ok(/¿Algo más/i.test(sinPromo), 'cierre habitual intacto');
});

test('4 · con promo Y upsell, el mensaje TERMINA con la pregunta del upsell', () => {
    // Si no, un "sí" de la clienta sería ambiguo entre la promo y el upselling.
    const msg = buildSanteConfirmationMessage({
        nombre: 'María', fecha: '2026-08-03', hora: '10:00',
        servicio: 'Mechas Balayage (cabello corto)', precio: 180, duracion: 240,
        categoria: 'Mechas Balayage', language: 'es', spaPromo: true,
        upsellSuggestion: 'Reconstrucción', upsellTono: 'cuidado_decoloracion',
    });
    const lineas = msg.split('\n').filter(Boolean);
    assert.ok(/¿Te la añado a la cita\?$/.test(lineas[lineas.length - 1]), 'la última línea es la del upsell');
    assert.ok(msg.indexOf('Spa Hair') < msg.indexOf('¿Te la añado'), 'la promo va antes');
    assert.ok(!/Spa Hair.*\?/s.test(msg.slice(msg.indexOf('Spa Hair'), msg.indexOf('💛', msg.indexOf('Spa Hair')))), 'la promo no plantea una pregunta');
});

test('4 · la promo está traducida en los 4 idiomas', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const msg = buildSanteConfirmationMessage({
            nombre: 'Anna', fecha: '2026-08-03', hora: '11:00',
            servicio: 'Manicura + gel', precio: 35, duracion: 120,
            categoria: 'Manicura/Pedicura', language: lang, spaPromo: true,
        });
        assert.ok(/Spa Hair/.test(msg) && /10\s*%/.test(msg), `falta la promo en ${lang}`);
    }
});

test('4 · la nota para el personal es reconocible y lleva fecha', () => {
    const nota = buildSpaPromoNote(new Date('2026-07-27T09:00:00Z'));
    assert.ok(nota.startsWith('[PROMO]'), 'marcador buscable en el panel');
    assert.ok(/Spa Hair\/Masajes/.test(nota));
    assert.ok(/27\/07\/2026/.test(nota), `fecha en formato es-ES: ${nota}`);
});
