// Renombrar una entrada del catálogo no puede mover el dinero de una cita ya reservada.
//
// Contexto: el 12/08/2026 Yulia pidió que los tres servicios de Spa Hair se llamaran como en
// su web, sin los minutos ("Relax 45min" → "Spa Hair Relax"). Había DOS citas confirmadas del
// 13/08 con service = 'Relax 45min' y sin el importe sellado. Renombrar solo el catálogo
// las habría facturado a 75 € en vez de 85, y —esto es lo que lo hace caro— **no como
// "sin poder calcular"**: `computeServiceBilling` cae a `extractServiceFromText`, el fuzzy
// manda 'relax' a la categoría 'Masajes y SPA' y devuelve 'Aromaterapia relax' con
// status 'ok'. Un importe distinto, presentado como cifra buena, sin que avise nadie.
// Y `stampBillingSnapshot` lo habría congelado al día siguiente. De ahí que la migración 040
// renombre las dos citas en la MISMA transacción que el catálogo.
//
// Lo que este fichero vigila, y lo que NO:
//   · SÍ · que cada entrada del catálogo siga facturando su propio precio por su nombre
//     completo (la mitad del daño de un renombrado es romper la resolución del propio
//     servicio) y que los tres nombres nuevos resuelvan a 85 / 115 / 110 €.
//   · SÍ · que el par «catálogo renombrado + cita renombrada» deje el importe INTACTO.
//   · NO · arreglar el remapeo silencioso. Es estructural y va mucho más allá de estos tres
//     servicios: medido contra el catálogo REAL de producción (12/08/2026), 21 de sus 81
//     entradas resuelven a OTRO precio con status 'ok' si su nombre desaparece, y 8 se van
//     además de categoría (Matiz 40 ⇄ Matiz plus 65, Mechas Airtouch XL 260 ⇄ Deco Total
//     Blond XL 175, Green Purity Detox 35 → 115…). El fuzzy de `computeServiceBilling` existe
//     para resolver etiquetas de upselling, y estrecharlo es un trabajo de diseño aparte:
//     tabla entera y por qué, en docs/observaciones-para-proxima-auditoria.md.
//     (Sobre ESTE fixture salen 20, no 21: le falta 'Difuminado de raíz' — otra deriva
//     anotada en el mismo documento.)
//
// Puro: cero red, cero Supabase, cero LLM.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    computeServiceBilling,
    buildFullServiceName,
    extractServiceFromText,
} = require('../services/helpers');

const CATALOGO = require('./fixtures/sante-catalog.json');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// El catálogo ANTERIOR a la 040. Se construye desde el fixture actual invirtiendo el
// renombrado, no a mano: así los precios, las duraciones, las categorías y el ORDEN son los
// mismos por construcción y la única diferencia entre los dos catálogos son los tres nombres.
// (El orden importa: `extractServiceFromText` desempata por cuál encuentra primero.)
const RENOMBRES = [
    ['Relax 45min', 'Spa Hair Relax', 85],
    ['Detox 60min', 'Spa Hair Detox', 115],
    ['Spa Hidratación 60min', 'Spa Hair Hidratación', 110],
];

const CATALOGO_ANTES = CATALOGO.map(s => {
    const r = RENOMBRES.find(([, nuevo]) => s.categoria === 'Spa Hair' && s.nombre === nuevo);
    return r ? { ...s, nombre: r[0] } : s;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Los dos catálogos se diferencian SOLO en los tres nombres
// ─────────────────────────────────────────────────────────────────────────────

test('el renombrado no toca nada más que el nombre (mismo orden, precio, duración, categoría)', () => {
    assert.strictEqual(CATALOGO_ANTES.length, CATALOGO.length);
    const diffs = [];
    CATALOGO.forEach((despues, i) => {
        const antes = CATALOGO_ANTES[i];
        if (antes.precio !== despues.precio) diffs.push(`[${i}] precio`);
        if (antes.duracion !== despues.duracion) diffs.push(`[${i}] duracion`);
        if (antes.categoria !== despues.categoria) diffs.push(`[${i}] categoria`);
        if (Object.keys(antes).join() !== Object.keys(despues).join()) diffs.push(`[${i}] claves`);
    });
    assert.deepStrictEqual(diffs, [], 'el renombrado ha movido algo que no era el nombre');

    const nombresCambiados = CATALOGO
        .map((d, i) => [CATALOGO_ANTES[i].nombre, d.nombre])
        .filter(([a, b]) => a !== b);
    assert.strictEqual(nombresCambiados.length, 3, 'tienen que cambiar exactamente tres nombres');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PROPIEDAD: cada servicio factura su propio precio por su nombre completo
// ─────────────────────────────────────────────────────────────────────────────
// Es la mitad del daño de cualquier renombrado: que la entrada deje de resolverse a sí
// misma. Corre sobre las 81 entradas, así que también protege los renombrados futuros.
// `precio: null` queda fuera A PROPÓSITO y no se cuela como 0: es el caso de "Consulta"
// ("se confirma en salón"), donde 'unpriced' es la respuesta correcta.

for (const [etiqueta, cat] of [['tras la 040', CATALOGO], ['antes de la 040', CATALOGO_ANTES]]) {
    test(`propiedad · cada servicio factura su propio precio por su nombre completo (${etiqueta}, ${cat.length} entradas)`, () => {
        const malos = [];
        for (const svc of cat) {
            if (svc.precio == null) continue;
            const full = buildFullServiceName(svc, cat);
            const r = computeServiceBilling(full, cat);
            const bien = r.segments.length === 1
                && r.segments[0].status === 'ok'
                && r.totalConIva === svc.precio;
            if (!bien) malos.push(`${full}: esperado ${svc.precio}€, obtenido ${r.totalConIva}€ ${JSON.stringify(r.segments)}`);
        }
        assert.deepStrictEqual(malos, [], 'hay servicios que no facturan su propio precio');
    });
}

// ── La versión FUERTE, que es la que este fichero nació debiendo tener ────────
// Cuando se escribió (12/08) salía en rojo por 21 de las 81 entradas y se dejó a medias a
// propósito, con el daño fijado como caracterización. Con la facturación ya estricta se puede
// exigir de verdad: **ninguna entrada, al desaparecer su nombre del catálogo, puede volver
// como 'ok' a otro precio.** O casa exacto, o sale marcada.
//
// Quitar una entrada es el modelo de las tres formas de quedarse huérfano: renombrarla (040),
// borrarla, o que alguien edite el `service` de una cita con una errata.
test('PROPIEDAD FUERTE · un nombre huérfano NUNCA vuelve como "ok" a otro precio', () => {
    const remapean = [];
    for (const svc of CATALOGO) {
        const full = buildFullServiceName(svc, CATALOGO);
        const antes = computeServiceBilling(full, CATALOGO);
        if (!antes.segments.every(s => s.status === 'ok')) continue;

        const sinEsa = CATALOGO.filter(s => s !== svc);
        const despues = computeServiceBilling(full, sinEsa);
        const todoOk = despues.segments.every(s => s.status === 'ok');
        if (todoOk && despues.totalConIva !== antes.totalConIva) {
            remapean.push(`${full} (${svc.categoria}): ${antes.totalConIva}€ → ${despues.totalConIva}€ como "ok"`);
        }
    }
    assert.deepStrictEqual(remapean, [],
        'el fallback difuso ha vuelto a la facturación: un nombre huérfano está cobrando otro precio en silencio');
});

// Los dos pares simétricos que hacían de esto un problema de dinero en las dos direcciones.
// Anclados a mano porque son los que se citaron al abrir el hallazgo, y porque un par es peor
// que un remapeo suelto: el error no tiene un signo, lo tiene cada dirección.
test('los pares simétricos: cada uno con su precio, y huérfano NO hereda el del otro', () => {
    const pares = [
        ['Matiz', 40, 'Matiz plus', 65],
        ['Mechas Airtouch XL', 260, 'Deco Total Blond XL', 175],
    ];
    for (const [unoNombre, unoPrecio, otroNombre, otroPrecio] of pares) {
        assert.strictEqual(computeServiceBilling(unoNombre, CATALOGO).totalConIva, unoPrecio, unoNombre);
        assert.strictEqual(computeServiceBilling(otroNombre, CATALOGO).totalConIva, otroPrecio, otroNombre);

        // Y con uno de los dos fuera del catálogo, el huérfano sale MARCADO, no con el precio
        // del vecino — que es exactamente el intercambio de 25 € y de 85 € del hallazgo.
        for (const [nombre, vecino] of [[unoNombre, otroPrecio], [otroNombre, unoPrecio]]) {
            const sinEsa = CATALOGO.filter(s => buildFullServiceName(s, CATALOGO) !== nombre);
            const r = computeServiceBilling(nombre, sinEsa);
            assert.strictEqual(r.segments[0].status, 'unmatched', `"${nombre}" huérfano debería salir marcado`);
            assert.notStrictEqual(r.totalConIva, vecino, `"${nombre}" ha heredado el precio del vecino`);
        }
    }
});

// El nombre crudo compartido ya estaba resuelto desde antes por 'ambiguous', y esto no lo
// toca: es la otra mitad de la protección y conviene que se vea junta.
test('el nombre crudo compartido sigue cayendo en "ambiguous", no en un precio', () => {
    const xl = computeServiceBilling('XL', CATALOGO);
    assert.strictEqual(xl.segments[0].status, 'ambiguous');
    assert.deepStrictEqual(xl.segments[0].precios, [175, 260]);
    assert.strictEqual(xl.totalConIva, 0, 'un nombre ambiguo no suma');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Los tres nombres nuevos, uno a uno
// ─────────────────────────────────────────────────────────────────────────────

test('los tres nombres nuevos resuelven a su propia entrada y a su propio precio', () => {
    for (const [, nuevo, precio] of RENOMBRES) {
        const svc = extractServiceFromText(nuevo, CATALOGO);
        assert.ok(svc, `"${nuevo}" no resuelve`);
        assert.strictEqual(svc.nombre, nuevo);
        assert.strictEqual(svc.categoria, 'Spa Hair', `"${nuevo}" se ha ido de categoría`);
        assert.strictEqual(computeServiceBilling(nuevo, CATALOGO).totalConIva, precio);
    }
});

test('el nombre de la web ya no cae en el masaje de otra categoría', () => {
    // Antes de la 040 esto era el bug al revés: el nombre que Yulia usa en su web
    // resolvía a 'Aromaterapia relax' (75 €, Masajes y SPA).
    assert.strictEqual(extractServiceFromText('Spa Hair Relax', CATALOGO_ANTES).nombre,
        'Aromaterapia relax', 'la premisa de la 040 ha cambiado: reléela');
    assert.strictEqual(extractServiceFromText('Spa Hair Relax', CATALOGO).nombre, 'Spa Hair Relax');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EL PAR: catálogo renombrado + cita renombrada = mismo dinero
// ─────────────────────────────────────────────────────────────────────────────

test('REGRESIÓN · una cita renombrada con su catálogo factura EXACTAMENTE igual que antes', () => {
    for (const [viejo, nuevo] of RENOMBRES) {
        const antes = computeServiceBilling(viejo, CATALOGO_ANTES);
        const despues = computeServiceBilling(nuevo, CATALOGO);
        assert.deepStrictEqual(
            { total: despues.totalConIva, estados: despues.segments.map(s => s.status) },
            { total: antes.totalConIva, estados: antes.segments.map(s => s.status) },
            `el renombrado ha movido el importe de "${viejo}"`);
    }
});

test('REGRESIÓN · una cita multi-servicio con un segmento renombrado tampoco se mueve', () => {
    // Es la forma en la que la 040 tiene que renombrar (replace, no igualdad): una cita
    // multi-servicio guarda "A + B" en una sola fila.
    const antes = computeServiceBilling('Corte mujer y secado + Relax 45min', CATALOGO_ANTES);
    const despues = computeServiceBilling('Corte mujer y secado + Spa Hair Relax', CATALOGO);
    assert.strictEqual(antes.totalConIva, 125, '40 + 85');
    assert.deepStrictEqual(despues.totalConIva, antes.totalConIva);
    assert.deepStrictEqual(despues.segments.map(s => s.status), ['ok', 'ok']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Los tres nombres viejos, ahora los tres MARCADOS
// ─────────────────────────────────────────────────────────────────────────────
// Cuando se escribió este fichero (12/08), «Relax 45min» huérfano devolvía **75 € con status
// 'ok'** —el masaje de otra categoría, presentado como cifra buena— y los otros dos caían en
// 'unmatched' porque los protege la regla de categorías cruzadas de la 028. Esa asimetría era
// la razón de que «Relax 45min» fuese el peligroso de los tres, y estaba fijada aquí como
// caracterización con la nota de que ponerse en rojo sería una buena noticia.
//
// Lo es: la facturación ya es estricta y los tres se comportan igual. Se releyó la 040 como
// pedía esa nota, y su decisión sigue en pie sin cambios — renombró las dos citas junto al
// catálogo, así que facturan sus 85 €. Lo que cambia es el coste de NO haberlo hecho: antes
// habrían sido 75 € congelados en silencio; ahora habría sido un 'unmatched' visible. La
// migración era correcta por el resultado, y ahora además el fallo estaría a la vista.
test('los tres nombres viejos caen a "unmatched": ninguno hereda un precio ajeno', () => {
    for (const [viejo, precioAjeno] of [['Relax 45min', 75], ['Detox 60min', 115], ['Spa Hidratación 60min', 110]]) {
        const r = computeServiceBilling(viejo, CATALOGO);
        assert.strictEqual(r.segments[0].status, 'unmatched', `"${viejo}" debería salir marcada`);
        assert.strictEqual(r.totalConIva, 0, `"${viejo}" no puede sumar`);
        assert.notStrictEqual(r.totalConIva, precioAjeno);
    }
});

// La prueba de que el remapeo silencioso no era hipotético, con una fila real de la BD.
// Migración 023 (01/08/2026): "Largo 1" → "Corto". La cita 96bca537 se quedó con el nombre
// viejo "Alisado vegano Largo 1" y hasta hoy facturaba **310 €** cuando su precio real era
// **210 €** — el difuso se llevaba la entrada "Largo" por el token. Un error de 100 € vivo en
// la base de datos, invisible solo porque la cita está cancelada. Es el mejor argumento de por
// qué la lectura tiene que ser estricta, y por eso vive en un test y no solo en un commit.
test('el caso REAL del 023: "Alisado vegano Largo 1" ya no cobra los 310 € de otra variante', () => {
    const r = computeServiceBilling('Alisado vegano Largo 1', CATALOGO);
    assert.strictEqual(r.segments[0].status, 'unmatched',
        'la cita 96bca537 tiene que salir marcada, no valorada');
    assert.notStrictEqual(r.totalConIva, 310, 'esto era el error: el precio de "Largo"');

    // Y el precio que de verdad le correspondía, para que se vea el tamaño del desvío.
    const corto = CATALOGO.find(s => s.nombre === 'Corto' && s.categoria === 'Alisado vegano');
    assert.strictEqual(corto.precio, 210, 'si "Corto" ya no son 210 €, releer la 023');
});
