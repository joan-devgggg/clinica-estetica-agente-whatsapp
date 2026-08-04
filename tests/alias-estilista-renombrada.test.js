// La dueña renombra a una estilista desde el panel (Olgha → Olga, 30/07/2026) y el
// reconocimiento de nombres tiene que seguir funcionando por los DOS lados:
//
//   · el nombre nuevo, que es el que sale del roster y el que el bot usa al hablar;
//   · el viejo, que las clientas de siempre seguirán escribiendo durante meses.
//
// Sin esto el renombrado es invisible hasta que una clienta pide a "Olgha", el matcher no
// la encuentra y la petición se descarta — el mismo silencio que resolveStylistMention vino
// a arreglar. Y al revés: un test que fije el nombre a mano caduca en el siguiente cambio,
// que es justo lo que pasó con los horarios de la Fase 6 de verify-sante-catalog.
//
// Hermético: roster en memoria, cero red.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { extractStylistFromText, resolveStylistMention, normalizeText } = require('../services/helpers');

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

// Roster con los nombres tal y como están HOY en stylists (incluido el renombrado).
const ROSTER = [
    { id: 'sty-veronika', name: 'Veronika' },
    { id: 'sty-irina', name: 'Irina' },
    { id: 'sty-yulia', name: 'Yulia' },
    { id: 'sty-olga', name: 'Olga' },            // antes 'Olgha'
    { id: 'sty-larisa', name: 'Larisa' },
    { id: 'sty-tetiana', name: 'Tetiana' },
    { id: 'sty-natalia', name: 'Natalia' },
    { id: 'sty-trico', name: 'Yulia-Tricóloga' },
];
const byName = (n) => ROSTER.find(s => normalizeText(s.name) === normalizeText(n));

test('el nombre NUEVO resuelve exacto', () => {
    const v = resolveStylistMention('quiero cita con Olga', ROSTER);
    assert.strictEqual(v.status, 'exact');
    assert.strictEqual(v.stylist.id, 'sty-olga');
    assert.strictEqual(extractStylistFromText('quiero cita con Olga', ROSTER)?.id, 'sty-olga');
});

test('el nombre VIEJO sigue llegando a la misma estilista', () => {
    for (const frase of ['con Olgha', 'pido hora con Olgha porfa', 'quiero con olgha']) {
        const v = resolveStylistMention(frase, ROSTER);
        assert.ok(['exact', 'fuzzy'].includes(v.status), `${frase} → ${v.status}`);
        assert.strictEqual(v.stylist?.id, 'sty-olga', frase);
        assert.strictEqual(extractStylistFromText(frase, ROSTER)?.id, 'sty-olga', frase);
    }
});

test('el renombrado no se traga a una desconocida de verdad', () => {
    // El riesgo de aflojar el matching para aceptar "Olgha" es aceptar cualquier cosa
    // parecida. "Helga" no está en el equipo y debe seguir avisando, no asignarse.
    const v = resolveStylistMention('quiero con Helga', ROSTER);
    assert.strictEqual(v.status, 'unknown');
    assert.strictEqual(extractStylistFromText('quiero con Helga', ROSTER), null);
});

test('cada estilista del roster se reconoce por su propio nombre', () => {
    // Invariante derivada del roster, sin lista de nombres escrita a mano: sobrevive a
    // cualquier alta, baja o renombrado que haga la dueña.
    for (const s of ROSTER) {
        const got = extractStylistFromText(`quiero cita con ${s.name}`, ROSTER);
        assert.strictEqual(got?.id, s.id, `"${s.name}" debe resolver a sí misma, resolvió a ${got?.name}`);
    }
});

test('un nombre que es prefijo de otro no se lleva las peticiones del largo', () => {
    // Yulia / Yulia-Tricóloga son dos personas distintas. La regla se comprueba sobre los
    // pares que existan en el roster, no sobre esos dos nombres en concreto.
    const pares = [];
    for (const a of ROSTER) {
        for (const b of ROSTER) {
            if (a.id !== b.id && normalizeText(b.name).startsWith(normalizeText(a.name))) pares.push([a, b]);
        }
    }
    assert.ok(pares.length > 0, 'el roster debe tener al menos un par prefijo (Yulia / Yulia-Tricóloga)');
    for (const [corto, largo] of pares) {
        assert.strictEqual(extractStylistFromText(`con ${corto.name}`, ROSTER)?.id, corto.id,
            `"${corto.name}" debe resolver a la corta`);
        assert.strictEqual(extractStylistFromText(`con ${largo.name}`, ROSTER)?.id, largo.id,
            `"${largo.name}" debe resolver a la larga`);
    }
});

test('Olga y Olgha son la MISMA estilista, no dos', () => {
    const a = extractStylistFromText('con Olga', ROSTER);
    const b = extractStylistFromText('con Olgha', ROSTER);
    assert.strictEqual(a?.id, b?.id);
    assert.strictEqual(byName('Olga').id, a?.id);
});
