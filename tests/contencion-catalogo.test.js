// Contención del catálogo (la cita de Ihab, 16/08/2026): un token que forma parte del
// nombre de OTRA categoría no puede reservar un servicio él solo.
//
// «Hola buenos días. Tienes cita libre mañana a las 14-15 h por ejemplo? Para lavar.» —
// la pasada 2 de extractServiceFromText casó 'lavar' contra el ÚNICO nombre de las 81
// entradas que lo contiene («Reconstrucción K18 + lavar y peinar», 60 €) y quedó una cita
// confirmada con ese service. El patrón: cuanto menos dice el cliente, peor — el nombre
// COMPLETO de la categoría arma catsMencionadas y devuelve null, el token suelto se colaba
// porque los nombres de categoría eran invisibles para la pasada 2. Tres víctimas vivas:
// lavar/peinar → K18 60 €, premium → Holistic 95 € (vs Color Premium), blond → Botanical
// 45 € (vs Deco Total Blond).
//
// La regla (no un parche para tres casos): el GANADOR de la pasada 2 necesita al menos un
// token de evidencia que no sea identidad de otra categoría. El índice token→categorías
// sale del catálogo en cada llamada, así que una entrada nueva con una palabra de otra
// categoría dentro queda cubierta sin tocar código — y el bloque «la regla como PROPIEDAD»
// de abajo lo comprobaría también sobre el catálogo que venga.
//
// Visto fallar sin el arreglo (regla 2, medido el 17/08/2026 con cp previo del fichero,
// regla 7): con el helpers.js anterior caen en rojo TRES bloques — el turno de Ihab, los
// cuatro contaminados y la propiedad («"premium" reservó "Holistic relajante Premium"»);
// el resto queda en verde: son las exenciones, que ya se cumplían y no pueden dejar de
// cumplirse. La mutación fina (quitar SOLO el veto `!contaminado` de los dos ganadores,
// dejando el índice) produce exactamente los mismos 3 rojos: lo que protege es el veto.
//
// Barrido completo viejo↔nuevo contra el catálogo VIVO (17/08/2026, solo lectura): 0
// cambios en 81 nombres crudos + completos + 22 categorías; 4 tokens de 94 (los de arriba,
// todos → null); 84 pares de 8.742, todos resolver→null sobre las tres entradas víctimas;
// 0 null→resuelve; 0 cambios en las 14 sugerencias vivas de upselling ni en los 53
// `appointments.service` históricos (que además ya no pasan por el difuso: f187270).
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    extractServiceFromText, resolveServiceCatalogEntry, buildFullServiceName,
    resolveStylistMention, normalizeText,
} = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json').services;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ─── El caso de Ihab y sus tres hermanos ─────────────────────────────────────

test('REGRESIÓN · el turno real de Ihab pregunta, no reserva', () => {
    // Byte a byte el primer mensaje de la conversación (messages, conv dfd8f36f). Antes
    // del arreglo resolvía «Reconstrucción K18 + lavar y peinar» y la cita se confirmó así.
    const turno = 'Hola buenos días. Tienes cita libre mañana a las 14-15 h por ejemplo? Para lavar.';
    assert.strictEqual(extractServiceFromText(turno, CATALOGO), null);
});

test('REGRESIÓN · los cuatro tokens contaminados devuelven null, solos y con marco', () => {
    // 'lavar' y 'peinar' son identidad de «Lavar y peinar»; 'premium' de «Color Premium»;
    // 'blond' de «Deco Total Blond». Ninguno puede reservar la entrada AJENA que los lleva
    // en el nombre (K18+lavar 60 €, Holistic 95 €, Botanical 45 €).
    for (const w of ['lavar', 'peinar', 'premium', 'blond']) {
        for (const t of [w, `para ${w}`, `quiero ${w}`]) {
            assert.strictEqual(extractServiceFromText(t, CATALOGO), null, `resolvió: "${t}"`);
        }
    }
});

test('la regla como PROPIEDAD: ningún token de un nombre de categoría resuelve una entrada de OTRA categoría', () => {
    // Es la regla entera, calculada del catálogo: si mañana se añade un servicio con una
    // palabra de otra categoría dentro, este bloque lo cubre sin tocar el test.
    const norm = s => normalizeText(s || '');
    const tokens = s => norm(s).split(/[^a-z0-9]+/).filter(w => w.length >= 5);
    let comprobados = 0;
    for (const svc of CATALOGO) {
        const catPropia = norm(svc.categoria);
        for (const w of tokens(svc.nombre)) {
            // Si el token ES el nombre entero de la entrada, resolverlo es la pasada 1a
            // haciendo su trabajo, no una fuga de la 2 — fuera de esta propiedad.
            if (w === norm(svc.nombre)) continue;
            const ajena = CATALOGO.some(o => norm(o.categoria) !== catPropia && tokens(o.categoria).includes(w));
            if (!ajena) continue;
            comprobados++;
            const r = extractServiceFromText(w, CATALOGO);
            assert.notStrictEqual(r, svc, `"${w}" reservó "${svc.nombre}" (${svc.categoria})`);
        }
    }
    // Que la propiedad no se quede sin casos por un rename del fixture: hoy son 4
    // (lavar y peinar en el K18 suelto, premium en Holistic, blond en Botanical).
    assert.ok(comprobados >= 4, `solo ${comprobados} pares token/entrada comprobados`);
});

// ─── La exención: lo que la puerta NO puede comerse (regla 12) ───────────────

test('un token limpio al lado del contaminado sigue ganando', () => {
    // La evidencia contaminada no descalifica al candidato: solo no puede ser TODA su
    // evidencia. Es la diferencia con las dos formulaciones descartadas (borrar el token
    // movía «peinado mujer»; descartar candidatos dejaba ganar a evidencia basura).
    const casos = [
        ['masaje relajante premium', 'Holistic relajante Premium'],
        ['higienica mujer', 'Higiénica mujer'],
        ['peinado mujer', 'Mujer y peinado Dyson'],
        ['brillo intensivo', 'Brillo intensivo'],
    ];
    for (const [t, esperado] of casos) {
        assert.strictEqual(extractServiceFromText(t, CATALOGO)?.nombre, esperado, `falla: "${t}"`);
    }
});

test('los tokens de la PROPIA categoría no contaminan', () => {
    // 'pedicura' está en el nombre de «Manicura/Pedicura», pero esa ES su categoría.
    assert.strictEqual(extractServiceFromText('pedicura esmaltado', CATALOGO)?.nombre, 'Pedicura + esmaltado');
    assert.strictEqual(extractServiceFromText('manicura con gel', CATALOGO)?.nombre, 'Manicura + gel');
});

test('los rescates de abreviatura de la pasada 2 siguen vivos', () => {
    // Lo que la pasada existe para hacer («aromaterapia» → su servicio) no puede pagarlo.
    const casos = [
        ['aromaterapia', 'Aromaterapia relax'],
        ['un masaje deportivo', 'Deportivo'],
        ['la tricologica', 'Consulta tricológica con Yulia'],
        ['señora', 'Señora'],
        ['esmaltado', 'Pedicura + esmaltado'],
    ];
    for (const [t, esperado] of casos) {
        assert.strictEqual(extractServiceFromText(t, CATALOGO)?.nombre, esperado, `falla: "${t}"`);
    }
});

test('el nombre completo de la categoría sigue comportándose igual (null: ambigua a propósito)', () => {
    assert.strictEqual(extractServiceFromText('lavar y peinar', CATALOGO), null);
    // Y con la variante dicha, resuelve dentro de la categoría.
    assert.strictEqual(extractServiceFromText('lavar y peinar señora', CATALOGO)?.nombre, 'Señora');
    // NO se afirma aquí el turno 2 real de Ihab («Soy hombre con pelo corto, lavar y
    // peinar es perfecto…»): resuelve «Hombre» (Cortes, 25 €) por otra vía — el keyword
    // 'corto' de CATEGORY_KEYWORDS más la palabra «hombre» del propio texto —, idéntico
    // ANTES y DESPUÉS de la contención (medido 17/08/2026). Es una rareza colindante,
    // preexistente y fuera del alcance de esta regla; fijarla en piedra aquí sería
    // congelar el estado actual, no proteger una conducta.
});

// ─── El lado facturación/persistencia: los 81 siguen resolviendo ─────────────

test('los 81 nombres completos resuelven a su propia entrada (resolveServiceCatalogEntry)', () => {
    // Es el camino con el que se persiste y se factura. Si la puerta se ensanchara hasta
    // tocar nombres completos, una cita pasada caería a «sin poder calcular» — el mismo
    // desenlace que borrarla. Aquí sale en rojo antes.
    for (const svc of CATALOGO) {
        const full = buildFullServiceName(svc, CATALOGO);
        const r = resolveServiceCatalogEntry(full, CATALOGO);
        assert.ok(r, `no resuelve: "${full}"`);
        assert.strictEqual(r.nombre, svc.nombre, `"${full}" → "${r.nombre}"`);
        assert.strictEqual(r.categoria, svc.categoria, `"${full}" cruzó a "${r.categoria}"`);
    }
});

// ─── El otro consumidor con la dirección opuesta ─────────────────────────────

test('un token que la puerta des-resuelve no se convierte en estilista inexistente', () => {
    // esNombreDePersona (resolveStylistMention, pasada 5) excluía estos tokens porque
    // RESOLVÍAN a servicio. Ya no resuelven — pero todo token contaminado es por definición
    // subcadena de un nombre de categoría, y el chequeo de categoría los sigue excluyendo.
    // Sin eso, «con premium» anunciaría "no tengo a ninguna Premium".
    const team = [{ name: 'Veronika' }, { name: 'Irina' }];
    for (const t of ['con premium', 'con lavar', 'con blond']) {
        const v = resolveStylistMention(t, team, { servicesCatalog: CATALOGO });
        assert.notStrictEqual(v.status, 'unknown', `"${t}" fabricó una estilista: ${JSON.stringify(v)}`);
    }
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
