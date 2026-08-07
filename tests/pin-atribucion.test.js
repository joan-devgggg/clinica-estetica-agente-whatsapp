// PIN de atribución por estilista (migración 036). 07/08/2026.
//
// El PIN NO es seguridad: no autoriza nada y no bloquea ningún cobro. Lo único que hace es
// distinguir "consta" (metió su PIN) de "se dijo" (solo eligió su nombre). Así que lo que se
// afirma aquí es sobre todo que NADA se bloquea, y que la distinción no se puede falsear:
//   · sin PIN, sin token, con token caducado o de otra estilista → el cobro se registra IGUAL;
//   · pero como 'declarada', nunca como 'confirmada';
//   · y el resumen de caja lo enseña repartido, o la columna no serviría de nada.
process.env.TZ = 'Europe/Madrid';
process.env.DASHBOARD_API_SECRET = 'secreto-de-test';

const assert = require('assert');
const {
    isValidPinFormat, hashPin, verifyPin, issueAttributionToken, verifyAttributionToken,
} = require('../services/pin');
const { buildCajaResumen } = require('../services/helpers');

let fallos = 0;
function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

const ORG = 'org-sante';
const IRINA = 'est-irina';
const OLGA = 'est-olga';

// ─── El hash ────────────────────────────────────────────────────────────────

test('1 · el PIN no se guarda en claro, y dos iguales no dan el mismo hash', () => {
    const a = hashPin('1234');
    const b = hashPin('1234');
    assert.ok(!a.hash.includes('1234'), 'el PIN no puede aparecer en el hash');
    assert.notStrictEqual(a.salt, b.salt, 'salt por fila');
    assert.notStrictEqual(a.hash, b.hash, 'mismo PIN, hashes distintos: sin salt se verían iguales en la tabla');
});

test('2 · verifyPin acepta el bueno y rechaza el resto sin lanzar', () => {
    const { hash, salt } = hashPin('4821');
    assert.strictEqual(verifyPin('4821', hash, salt), true);
    assert.strictEqual(verifyPin('4822', hash, salt), false);
    assert.strictEqual(verifyPin('', hash, salt), false);
    assert.strictEqual(verifyPin(null, hash, salt), false);
    // Un hash de otra longitud haría LANZAR a timingSafeEqual si no se comprobara antes.
    assert.strictEqual(verifyPin('4821', 'abc', salt), false);
    assert.strictEqual(verifyPin('4821', hash, null), false);
});

test('3 · formato: 4 a 6 dígitos, nada más', () => {
    assert.ok(isValidPinFormat('1234'));
    assert.ok(isValidPinFormat('123456'));
    assert.ok(!isValidPinFormat('123'), '3 dígitos son 1.000 combinaciones');
    assert.ok(!isValidPinFormat('1234567'));
    assert.ok(!isValidPinFormat('12a4'));
    assert.ok(!isValidPinFormat(''));
    assert.throws(() => hashPin('12'), /4 a 6 dígitos/);
});

// ─── El token de atribución ─────────────────────────────────────────────────

test('4 · un token válido identifica a su estilista', () => {
    const t = issueAttributionToken({ orgId: ORG, stylistId: IRINA, minutos: 30 });
    assert.strictEqual(verifyAttributionToken(t, { orgId: ORG })?.stylistId, IRINA);
});

test('5 · el token NO contiene el PIN', () => {
    const t = issueAttributionToken({ orgId: ORG, stylistId: IRINA });
    const cuerpo = Buffer.from(t.split('.')[0], 'base64url').toString('utf8');
    assert.ok(!/pin/i.test(cuerpo), 'el PIN no viaja nunca al navegador');
    assert.deepStrictEqual(Object.keys(JSON.parse(cuerpo)).sort(), ['exp', 'o', 's', 'v']);
});

test('6 · caducado no vale, y la caducidad la fija el servidor', () => {
    const ahora = Date.now();
    const t = issueAttributionToken({ orgId: ORG, stylistId: IRINA, minutos: 30, ahora });
    assert.ok(verifyAttributionToken(t, { orgId: ORG, ahora: ahora + 29 * 60_000 }), 'dentro de ventana');
    assert.strictEqual(verifyAttributionToken(t, { orgId: ORG, ahora: ahora + 31 * 60_000 }), null, 'fuera de ventana');
});

test('7 · un token manipulado o de otra org no vale', () => {
    const t = issueAttributionToken({ orgId: ORG, stylistId: IRINA });
    // Cambiar el cuerpo para decir que es de Olga invalida la firma.
    const cuerpo = JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
    cuerpo.s = OLGA;
    const falso = `${Buffer.from(JSON.stringify(cuerpo)).toString('base64url')}.${t.split('.')[1]}`;
    assert.strictEqual(verifyAttributionToken(falso, { orgId: ORG }), null, 'firma rota');
    assert.strictEqual(verifyAttributionToken(t, { orgId: 'otra-org' }), null, 'token de otra organización');
    assert.strictEqual(verifyAttributionToken('basura', { orgId: ORG }), null);
    assert.strictEqual(verifyAttributionToken(null, { orgId: ORG }), null);
});

test('8 · sin DASHBOARD_API_SECRET no se emite un token inservible en silencio: se lanza', () => {
    const previo = process.env.DASHBOARD_API_SECRET;
    delete process.env.DASHBOARD_API_SECRET;
    try {
        assert.throws(() => issueAttributionToken({ orgId: ORG, stylistId: IRINA }), /DASHBOARD_API_SECRET/);
        assert.strictEqual(verifyAttributionToken('x.y', { orgId: ORG }), null);
    } finally { process.env.DASHBOARD_API_SECRET = previo; }
});

// ─── El resumen: la distinción tiene que VERSE ──────────────────────────────

const COBROS = [
    { cobrado_por: IRINA, cobrado_por_nombre: 'Irina', metodo: 'efectivo', importe_total: '100.00', importe_efectivo: '100.00', atribucion: 'confirmada' },
    { cobrado_por: IRINA, cobrado_por_nombre: 'Irina', metodo: 'mixto',    importe_total: '60.00',  importe_efectivo: '20.00',  atribucion: 'declarada' },
    { cobrado_por: OLGA,  cobrado_por_nombre: 'Olga',  metodo: 'tarjeta',  importe_total: '35.00',  importe_efectivo: '0.00',   atribucion: 'confirmada' },
    { cobrado_por: null,  cobrado_por_nombre: null,    metodo: 'efectivo', importe_total: '15.00',  importe_efectivo: '15.00',  atribucion: 'declarada' },
];

test('9 · el resumen reparte por atribución, y sobre todo el EFECTIVO', () => {
    const r = buildCajaResumen(COBROS, { stylists: [] });
    assert.strictEqual(r.totales.total, 210);
    assert.strictEqual(r.totales.efectivo, 135);
    assert.strictEqual(r.totales.tarjeta, 75);
    // La cifra que importa: efectivo que nadie confirmó.
    assert.strictEqual(r.totales.confirmada.efectivo, 100);
    assert.strictEqual(r.totales.declarada.efectivo, 35, '20 del mixto de Irina + 15 sin estilista');
    assert.strictEqual(r.totales.confirmada.num, 2);
    assert.strictEqual(r.totales.declarada.num, 2);
});

test('10 · por estilista, y los totales cuadran con la suma de las filas', () => {
    const r = buildCajaResumen(COBROS, { stylists: [] });
    const irina = r.estilistas.find(e => e.stylist_id === IRINA);
    assert.strictEqual(irina.total, 160);
    assert.strictEqual(irina.efectivo, 120);
    assert.strictEqual(irina.confirmada.total, 100);
    assert.strictEqual(irina.declarada.total, 60);
    assert.ok(r.estilistas.find(e => e.stylist_id === null), 'el grupo sin estilista existe');
    assert.strictEqual(
        r.estilistas.reduce((s, e) => s + e.total, 0), r.totales.total,
        'el total global es la suma de las filas ya redondeadas',
    );
});

test('11 · ante la duda, la afirmación más humilde', () => {
    // Un valor raro o ausente NO puede contar como confirmada.
    const raros = [
        { cobrado_por: IRINA, metodo: 'efectivo', importe_total: '10.00', importe_efectivo: '10.00' },
        { cobrado_por: IRINA, metodo: 'efectivo', importe_total: '10.00', importe_efectivo: '10.00', atribucion: 'CONFIRMADA' },
        { cobrado_por: IRINA, metodo: 'efectivo', importe_total: '10.00', importe_efectivo: '10.00', atribucion: null },
    ];
    const r = buildCajaResumen(raros, { stylists: [] });
    assert.strictEqual(r.totales.confirmada.num, 0, 'solo el literal exacto "confirmada" cuenta como confirmada');
    assert.strictEqual(r.totales.declarada.num, 3);
});

test('12 · el nombre CONGELADO manda sobre el catálogo actual', () => {
    // Renombrar a una estilista no puede reescribir un cierre pasado.
    const r = buildCajaResumen(
        [{ cobrado_por: IRINA, cobrado_por_nombre: 'Irina', metodo: 'efectivo', importe_total: '10.00', importe_efectivo: '10.00', atribucion: 'confirmada' }],
        { stylists: [{ id: IRINA, name: 'Irina Nuevo Apellido' }] },
    );
    assert.strictEqual(r.estilistas[0].stylist_name, 'Irina');
});

test('13 · un día sin cobros da un resumen a cero, no un error', () => {
    const r = buildCajaResumen([], { stylists: [] });
    assert.deepStrictEqual(r.estilistas, []);
    assert.strictEqual(r.totales.total, 0);
    assert.strictEqual(r.totales.declarada.efectivo, 0);
});

console.log(fallos === 0 ? '\n✅ PIN de atribución OK' : `\n❌ ${fallos} fallo(s)`);
