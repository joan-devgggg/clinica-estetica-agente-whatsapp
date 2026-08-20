// Un servicio que SOLO se vende como complemento (`solo_complemento: true`).
//
// Yulia (19/08/2026): «Peinado con tratamientos», 15 € y 15 min, que NUNCA se vende suelto
// — no se puede peinar sin lavar, y la clienta llega con la cabeza ya lavada del
// tratamiento. Es el patrón del K18 sin la mitad del suelto.
//
// LA GARANTÍA NO ES UNA LÍNEA DEL PROMPT, y no puede serlo: ya sabemos cómo acaba eso —el
// 02/08/2026 el modelo vio la «Consulta de valoración» en el menú del catálogo, la ofreció
// e inventó un híbrido con la consulta tricológica. La garantía es que la entrada NO EXISTE
// en el catálogo que ve el modelo ni en el que usan los detectores (`botOfferableCatalog`).
// El bloque del prompt está para que sepa CONTESTAR, no para que obedezca.
//
// LA MARCA VIVE EN LA ENTRADA, no en un Set de categorías en el código: la categoría la
// edita la dueña sobre el JSONB y un Set contra su nombre deja de casar el día que la
// renombre — el servicio se volvería ofertable EN SILENCIO (regla 5). `activo` ya resolvió
// esto mismo así.
//
// Y EL CONTRAPESO, que es la mitad que se rompe sin ruido: lo que RESUELVE sigue viendo el
// catálogo COMPLETO. La facturación de una cita que ya lo lleva, la duración del upsell y
// la traducción de su etiqueta no pueden apagarse — un filtro metido ahí no lo detecta
// ningún test de oferta. Es la lección de `offerableCatalog`, escrita en su propio
// comentario, y el bloque 4 la vigila.
//
// Visto fallar sin lo que protege (cp previo, rojos MEDIDOS el 19/08/2026):
//   · `botOfferableCatalog` deja de filtrar   → 4 rojos: entra en el menú del modelo, la
//     detección libre lo selecciona, y los dos catálogos dejan de ser dos cosas;
//   · la marca por truthy en vez de `=== true` → 1 rojo: un `solo_complemento: "true"` o
//     `0` de un editor a medio escribir escondería (o no) un servicio sin querer;
//   · sin el bloque descriptivo del prompt     → 3 rojos: el modelo no sabe que existe y a
//     «¿me peinas después del tratamiento?» contesta que no lo hacemos;
//   · anclajes escritos a mano en vez de salir de las reglas → 1 rojo: la segunda lista;
//   · el panel también se filtra               → 1 rojo: la dueña no puede añadirlo a mano.
//     (Ese último lo caza el bloque de CONDUCTA, no el grep: el sabotaje entró por un alias
//     del import y la línea que el grep busca seguía intacta. El grep vale para el
//     copy-paste, no para un alias.)
//
// Valores INVENTADOS a propósito (regla 5): si alguien fija aquí el catálogo real, el
// fichero deja de medir la conducta y pasa a medir antigüedad.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Telegram inerte ANTES de requerir webhook: ni bot, ni red.
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyReservaWeb: async () => {}, notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const {
    offerableCatalog, botOfferableCatalog, isComplementOnlyService,
    extractServiceFromText, computeServiceBilling, resolveAcceptedUpsellNames,
    resolveServiceDurationMin, buildFullServiceName, normalizeText,
} = require('../services/helpers');
const { buildSystemPrompt } = require('../services/providers/openai');

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const COMPLEMENTO = 'Retoque sin lavado';

const BASE = [
    { nombre: 'Ondas de gala',      precio: 40, duracion: 60, categoria: 'Peinados de prueba' },
    { nombre: 'Recogido de gala',   precio: 45, duracion: 90, categoria: 'Peinados de prueba' },
    { nombre: 'Elixir de prueba',   precio: 60, duracion: 90, categoria: 'Tratamiento de prueba' },
    { nombre: 'Bálsamo de prueba',  precio: 35, duracion: 40, categoria: 'Tratamiento de prueba' },
    { nombre: 'Corte de prueba',    precio: 25, duracion: 30, categoria: 'Cortes de prueba' },
];
const ENTRADA = {
    nombre: COMPLEMENTO, precio: 15, duracion: 15,
    categoria: 'Peinados de prueba', solo_complemento: true,
};
const CAT = [...BASE, ENTRADA];
const UPSELL = [{ servicio: 'Tratamiento de prueba', sugerencias: [COMPLEMENTO] }];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function prompt({ services = CAT, upselling = UPSELL } = {}) {
    return buildSystemPrompt(SANTE, {}, null, false, null, {
        business_info: { companyName: 'Salón de prueba', direccion: 'Calle Falsa 123', upselling },
        services, tone: 'cercano',
    });
}
const menuCatalogo = p => {
    const i = p.indexOf('# ── CATÁLOGO DE SERVICIOS');
    return i < 0 ? '' : p.slice(i, p.indexOf('REDACCIÓN:', i));
};

// ═══ 1 · La garantía: no está en el menú, y su categoría sobrevive ═════════════════

test('el complemento NO llega al catálogo que ve el modelo', () => {
    const menu = menuCatalogo(prompt());
    assert.ok(menu, 'no se ha encontrado el catálogo en el prompt');
    assert.ok(!menu.includes(COMPLEMENTO), `el complemento está en el menú:\n${menu}`);
    // Y el filtro no puede llevarse la categoría por delante: los peinados de verdad, que
    // son lo que hay que ofrecerle a quien pide «un peinado», siguen ahí.
    assert.ok(menu.includes('Ondas de gala') && menu.includes('Recogido de gala'),
        `el filtro se ha comido la categoría entera:\n${menu}`);
});

test('pero el modelo SÍ sabe que existe, y con qué va', () => {
    const p = prompt();
    assert.ok(/COMPLEMENTO, NUNCA SUELTO/.test(p), 'falta el bloque descriptivo');
    assert.ok(p.includes(`${COMPLEMENTO.toUpperCase()} (15€, 15 min)`), 'falta precio o duración');
    assert.ok(/Solo se añade a estos servicios: Tratamiento de prueba\./.test(p),
        'no dice a qué se ata, que es justo lo que pidió Yulia');
    assert.ok(/NO lo ofrezcas tú por iniciativa propia/.test(p),
        'sin esto, el modelo puede leer el bloque como permiso para proponerlo');
});

test('el PORQUÉ sale de la entrada, no del código', () => {
    // «No se puede peinar sin lavar» es cierto de ESTE complemento y de ninguno más. Escrito
    // en el código, el día que la dueña añada otro se lo explicaría con el motivo ajeno.
    const conNota = prompt({ services: [...BASE, { ...ENTRADA, nota: 'motivo inventado de prueba' }] });
    assert.ok(/El porqué, por si viene a cuento: motivo inventado de prueba/.test(conNota),
        'la nota de la entrada no llega al prompt');
    assert.ok(!/El porqué/.test(prompt()), 'sin nota no se da motivo (regla 3)');
    assert.ok(!/peinar sin lavar/i.test(conNota), 'hay un motivo escrito en el código');
});

test('los anclajes salen de las REGLAS, no de una segunda lista', () => {
    // Una lista escrita en el prompt y otra en business_info.upselling se separan en el
    // primer retoque y el bot promete algo que luego no ofrece. Es formatReminderWhen.
    const otra = prompt({ upselling: [{ servicio: 'Cortes de prueba', sugerencias: [COMPLEMENTO] }] });
    assert.ok(/Solo se añade a estos servicios: Cortes de prueba\./.test(otra),
        'el bloque no sigue a las reglas: hay una lista duplicada en alguna parte');
});

test('sin reglas que lo nombren NO se dice a qué se ata (regla 3)', () => {
    const p = prompt({ upselling: [] });
    assert.ok(/COMPLEMENTO, NUNCA SUELTO/.test(p), 'la prohibición es cierta sin datos y se queda');
    assert.ok(!/Solo se añade a estos servicios:/.test(p), 'se ha inventado la lista de anclajes');
    assert.ok(/no hay ninguno configurado/.test(p), 'y hay que decir que no se sabe');
});

// ═══ 2 · Los dos catálogos, que son dos cosas distintas ════════════════════════════

test('botOfferableCatalog lo quita; offerableCatalog NO', () => {
    assert.ok(!botOfferableCatalog(CAT).some(s => s.nombre === COMPLEMENTO),
        'el bot podría proponerlo');
    assert.ok(offerableCatalog(CAT).some(s => s.nombre === COMPLEMENTO),
        'el panel dejaría de poder añadirlo a mano, y entonces la caja no cuadra');
    assert.strictEqual(botOfferableCatalog(CAT).length, BASE.length);
});

test('la detección libre no puede seleccionarlo, y la resolución sí', () => {
    const filtrado = botOfferableCatalog(CAT);
    for (const frase of [COMPLEMENTO.toLowerCase(), `quiero un ${COMPLEMENTO.toLowerCase()}`]) {
        assert.strictEqual(extractServiceFromText(frase, filtrado), null,
            `se seleccionó como servicio principal: "${frase}"`);
    }
    const resuelto = extractServiceFromText(COMPLEMENTO, CAT);
    assert.ok(resuelto && resuelto.nombre === COMPLEMENTO,
        'contra el catálogo COMPLETO tiene que seguir resolviendo: es lo que necesita la '
        + 'facturación de una cita que ya lo lleva');
});

test('la marca ausente o a medio escribir NO esconde nada', () => {
    for (const v of [undefined, null, false, 'true', 0]) {
        const svc = { nombre: 'X', precio: 1, duracion: 1, categoria: 'C', solo_complemento: v };
        assert.strictEqual(isComplementOnlyService(svc), false, `solo_complemento=${JSON.stringify(v)} escondió el servicio`);
    }
    assert.strictEqual(isComplementOnlyService(ENTRADA), true);
    assert.strictEqual(isComplementOnlyService(null), false);
});

// ═══ 3 · Contención: la entrada nueva no mueve NINGUNA resolución (propiedad) ══════

test('PROPIEDAD · añadir la entrada no cambia ni una resolución existente', () => {
    // El mismo barrido que se hizo contra el catálogo vivo, aquí como propiedad sobre el
    // fixture: sondas = nombres crudos, nombres completos, categorías y todos los tokens de
    // ≥4 letras. Si un nombre nuevo roba un token («Plancha u ondas» le robaría `ondas` a
    // «Ondas de gala»), este bloque lo dice con el token en pantalla.
    const sondas = new Set();
    for (const s of BASE) {
        sondas.add(s.nombre);
        sondas.add(buildFullServiceName(s, BASE));
        sondas.add(s.categoria);
        for (const w of normalizeText(`${s.nombre} ${s.categoria}`).split(/[^a-z0-9]+/)) {
            if (w.length >= 4) sondas.add(w);
        }
    }
    const nom = x => (x ? `${x.categoria}·${x.nombre}` : 'null');
    const movidas = [];
    for (const sonda of sondas) {
        const antes = nom(extractServiceFromText(sonda, BASE));
        const despues = nom(extractServiceFromText(sonda, CAT));
        if (antes !== despues && antes !== 'null') movidas.push(`"${sonda}": ${antes} → ${despues}`);
    }
    assert.deepStrictEqual(movidas, [], `la entrada nueva mueve resoluciones vivas:\n  ${movidas.join('\n  ')}`);
});

// ═══ 4 · El contrapeso: lo que RESUELVE ve el catálogo completo ════════════════════

test('la facturación suma el complemento, y no trocea nombres con " + "', () => {
    const r = computeServiceBilling(`Elixir de prueba + ${COMPLEMENTO}`, CAT);
    assert.strictEqual(r.totalConIva, 75, 'no suma los 15 € del complemento');
    assert.deepStrictEqual(r.segments.map(s => s.status), ['ok', 'ok']);
});

test('la etiqueta de upselling casa EXACTO contra el catálogo', () => {
    // Es lo que evita la deuda de business_info.upselling: 7 de las 9 etiquetas vivas de
    // Sante son frases de marketing que solo resuelven por parecido. Aquí la etiqueta y el
    // nombre de catálogo son la MISMA cadena a propósito.
    const { resueltos } = resolveAcceptedUpsellNames([COMPLEMENTO], 'Tratamiento de prueba', CAT);
    assert.strictEqual(resueltos[0].via, 'exacto');
    assert.strictEqual(resueltos[0].nombre, COMPLEMENTO);
    assert.strictEqual(resolveServiceDurationMin(COMPLEMENTO, CAT), 15);
});

test('LA TRAMPA · con el catálogo filtrado, la resolución se apaga en silencio', () => {
    // Este bloque no prueba una conducta buena: mide lo que COSTARÍA meter el filtro en el
    // sitio equivocado, para que quede escrito qué se rompe. Ningún test de oferta se
    // enteraría de ninguna de las tres.
    const filtrado = botOfferableCatalog(CAT);
    assert.strictEqual(computeServiceBilling(`Elixir de prueba + ${COMPLEMENTO}`, filtrado).totalConIva, 60,
        'si esto ya no baja de 75, el filtro dejó de importar aquí y el bloque sobra');
    assert.strictEqual(
        resolveAcceptedUpsellNames([COMPLEMENTO], 'Tratamiento de prueba', filtrado).resueltos[0].resuelto, false);
    assert.notStrictEqual(resolveServiceDurationMin(COMPLEMENTO, filtrado), 15);
});

test('chokepoint · los sitios que RESUELVEN reciben el catálogo completo', () => {
    // Grep, con lo que eso vale: no atrapa un call site nuevo, sí el copy-paste de uno.
    const bot = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    for (const linea of [
        'const catalogDur = agentCfgDur?.services || [];',
        'const catUp = cfgK18?.services || [];',
    ]) {
        assert.ok(bot.includes(linea),
            `cambió el catálogo de una resolución: "${linea}" ya no está en bot.js`);
    }
    const webhook = fs.readFileSync(path.join(__dirname, '..', 'webhook.js'), 'utf8');
    assert.ok(/const catalog = incluirInactivos \? completo : offerableCatalog\(completo\);/.test(webhook),
        'el desplegable del panel tiene que seguir en offerableCatalog: ahí decide una persona');
});

// ═══ 5 · El panel: la ruta real, con servidor ═════════════════════════════════════

test('GET /api/service-catalog SÍ trae el complemento', async () => {
    const db = require('../services/db');
    db.authenticateToken = async t => (t === 'tok' ? { userId: 'u', orgId: SANTE } : null);
    db.getAgentConfig = async () => ({ services: CAT });
    const { app } = require('../webhook');
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        const pedir = ruta => new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: server.address().port, method: 'GET', path: ruta,
                headers: { Authorization: 'Bearer tok' },
            }, res => {
                let d = ''; res.on('data', c => (d += c));
                res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
            });
            req.on('error', reject); req.end();
        });
        for (const ruta of ['/api/service-catalog', '/api/service-catalog?incluirInactivos=1']) {
            const res = await pedir(ruta);
            assert.strictEqual(res.status, 200, ruta);
            assert.ok(res.body.some(e => e.nombre === COMPLEMENTO),
                `${ruta} no trae el complemento: la dueña no podría añadirlo a mano`);
        }
    } finally {
        await new Promise(r => server.close(r));
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
