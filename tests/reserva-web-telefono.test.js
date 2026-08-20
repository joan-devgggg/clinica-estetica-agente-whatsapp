/**
 * tests/reserva-web-telefono.test.js — Que el enlace no le invente el teléfono a nadie.
 *
 * ── EL FALLO ─────────────────────────────────────────────────────────────────────────────
 *
 * El formulario tenía UN campo de teléfono, un número pelado, y el servidor se lo daba a
 * `sanitizePhone`, que prefija `34` a todo lo que sean nueve dígitos empezados por 6 o 7.
 * Un móvil ucraniano escrito sin el 0 del tronco es EXACTAMENTE eso:
 *
 *     «67 123 45 67»  →  671234567  →  sanitizePhone  →  34671234567
 *
 * Y eso no es un número que no exista: es un móvil ESPAÑOL, de otra persona. `contacts`
 * tiene UNIQUE (organization_id, wa_phone), así que si esa española ya es clienta, la cita
 * web se cuelga de SU ficha, la lista negra se comprueba contra ELLA y el recordatorio de
 * 24 h se lo lleva ELLA. El caso ruso falla más barato —diez dígitos, no casa el patrón, se
 * guarda tal cual y como no es de nadie Meta responde 200 y no entrega (hecho 3)— pero
 * tampoco recibe el recordatorio.
 *
 * Medido contra producción el 21/08/2026: de 771 fichas de Sante, 735 son `34`+9 y 36 no lo
 * son; de esas 36, CINCO no son un teléfono (dos empiezan por `0`, dos tienen menos de diez
 * dígitos, una está vacía). Y eso sin que el enlace haya escrito ni una (`source='web'` = 0).
 *
 * ── LO QUE ESTE FICHERO VIGILA, EN UNA LÍNEA ─────────────────────────────────────────────
 *
 * Que lo que se guarda lleve SIEMPRE prefijo de país, que el camino español siga saliendo
 * byte por byte igual que ayer, y que `sanitizePhone` —compartida con San Remo y con el
 * pipeline de entrada— no se haya tocado.
 *
 * ── Sabotajes medidos (22/08/2026) ───────────────────────────────────────────────────────
 *
 *   · volver al camino de ayer (`sanitizePhone` del número pelado) .............. 11 rojos
 *   · poner una guarda de largo al quitar el tronco (el bug alemán, ver abajo) ... 1 rojo
 *   · darle troncal '0' a Italia (el fijo italiano lleva su 0 dentro) ............ 1 rojo
 *   · componer sin comprobar que el prefijo está en la tabla ..................... 1 rojo
 *   · quitar la puerta del '+' (un país fuera de la lista no podría reservar) .... 2 rojos
 *   · publicar `troncal` y `nsn` en la lista que va al navegador ................. 1 rojo
 *   · que `paisesPublicos` no empiece por España ................................. 1 rojo
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const {
    PAISES, PAIS_POR_DEFECTO, paisesPublicos, componerTelefono,
} = require('../services/reserva-web');
// La implementación REAL, no un doble: la mitad de lo que se afirma aquí es precisamente
// que componer y luego sanear no se pisan.
const { sanitizePhone } = require('../services/db');

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

/** Lo que de verdad se escribiría en `contacts.wa_phone`: componer y luego sanear, que es
 *  lo que hace el handler. Todo lo que se afirma aquí se afirma sobre ESTA cadena. */
function guardado(prefijo, numero) {
    const r = componerTelefono({ prefijo, numero });
    return r.ok ? sanitizePhone(r.telefono) : null;
}

// ─── 1 · El camino que HOY funciona, byte por byte ───────────────────────────────────────
//
// 735 de las 771 fichas de Sante son móviles españoles. Este bloque es el candado: lo que
// salía ayer tiene que salir hoy, escriba ella el número como lo escriba.

test('el móvil español sale igual que antes de todo esto', () => {
    for (const escrito of ['600123456', '600 12 34 56', '600-12-34-56', ' 600123456 ', '600.12.34.56']) {
        assert.strictEqual(guardado('34', escrito), '34600123456', escrito);
    }
});

test('y también si lo escribe con el prefijo delante, de las tres formas', () => {
    for (const escrito of ['+34600123456', '34600123456', '0034 600 123 456', '+34 600 12 34 56']) {
        assert.strictEqual(guardado('34', escrito), '34600123456', escrito);
    }
});

test('lo que salía ayer sale hoy: el resultado es el mismo que `sanitizePhone` a secas', () => {
    // La comprobación fuerte del candado. Para un móvil español —el 95 % del tráfico— el
    // camino nuevo y el viejo tienen que coincidir, o esto sería una migración encubierta.
    for (const n of ['600123456', '712345678', '34600123456', '+34600123456']) {
        assert.strictEqual(guardado('34', n), sanitizePhone(n), n);
    }
});

// ─── 2 · EL BUG. Un móvil de fuera ya no se convierte en uno español ─────────────────────

test('el móvil ucraniano sin el 0 del tronco YA NO sale como un móvil español', () => {
    // La línea entera del incidente: 671234567 daba 34671234567, que es de otra persona.
    assert.strictEqual(sanitizePhone('671234567'), '34671234567',
        'si esto cambia, es que alguien ha tocado sanitizePhone — que es de San Remo también');
    assert.strictEqual(guardado('380', '671234567'), '380671234567');
});

test('la ucraniana lo escriba como lo escriba, sale su número', () => {
    for (const escrito of ['671234567', '0671234567', '380671234567', '+380671234567',
                           '067 123 45 67', '+380 67 123 45 67']) {
        assert.strictEqual(guardado('380', escrito), '380671234567', escrito);
    }
});

test('el móvil ruso, con y sin el 8 del tronco', () => {
    // El tronco ruso es un 8, no un 0. Sin declararlo, «8 916…» se guardaría como
    // 789161234567 — trece dígitos que no son de nadie.
    for (const escrito of ['9161234567', '89161234567', '79161234567', '+7 916 123-45-67']) {
        assert.strictEqual(guardado('7', escrito), '79161234567', escrito);
    }
});

test('NINGÚN país de la tabla puede producir un número sin prefijo', () => {
    // El invariante que resume el fichero, y se comprueba sobre la tabla entera para que un
    // país nuevo tenga que pasar por aquí. Se prueba con un número nacional del largo mínimo
    // que declara cada uno.
    for (const p of PAISES) {
        const nacional = '1'.repeat(p.nsn[0]);
        const out = guardado(p.codigo, nacional);
        assert.ok(out, `${p.iso}: no compuso nada con ${nacional}`);
        assert.ok(out.startsWith(p.codigo), `${p.iso}: «${out}» no empieza por ${p.codigo}`);
        assert.ok(!out.startsWith('0'), `${p.iso}: «${out}» empieza por 0`);
        assert.ok(out.length >= 8 && out.length <= 15, `${p.iso}: «${out}» mide ${out.length}`);
    }
});

// ─── 3 · Las dos podas: el prefijo duplicado y el dígito de salida nacional ──────────────

test('Italia CONSERVA su 0: es la excepción, y hay tres contactos italianos', () => {
    // +39 06 … es Roma. Un troncal '0' en Italia dejaría 39612345678, que es otro número.
    assert.strictEqual(guardado('39', '0612345678'), '390612345678');
    assert.strictEqual(guardado('39', '3331234567'), '393331234567', 'y el móvil, que no lleva 0');
    const italia = PAISES.find(p => p.iso === 'IT');
    assert.strictEqual(italia.troncal, null,
        'Italia con troncal se lleva por delante el 0 de todos sus fijos');
});

test('el 0 del tronco se va AUNQUE el largo ya pareciera válido (el caso alemán)', () => {
    // La versión con guarda de largo —«solo quito el 0 si al quitarlo el largo queda
    // válido»— funciona con España, que tiene un largo único, y falla en cuanto el rango es
    // ancho: 01701234567 mide once, once está dentro del rango alemán [6, 11], así que el 0
    // se quedaba dentro y salía 4901701234567. No lo cazó nadie leyendo: lo cazó medir el
    // sabotaje y verlo dar CERO rojos.
    assert.strictEqual(guardado('49', '01701234567'), '491701234567');
    assert.strictEqual(guardado('49', '1701234567'), '491701234567', 'y sin el tronco, igual');
    assert.strictEqual(guardado('49', '+49 170 1234567'), '491701234567');
    // Y lo mismo con la otra mitad del par: 8 y 0 son el mismo caso con otro dígito.
    assert.strictEqual(guardado('7', '89161234567'), '79161234567');
});

test('quitarle el prefijo a un número que ya lo lleva NO cambia el número', () => {
    // La poda (a) por sí sola es un no-op: se quita el código y se vuelve a poner. Es lo que
    // la hace segura aunque se equivoque — y lo que permite que un móvil italiano que
    // empieza por «39» (392, 393… son prefijos de móvil reales) pase por ella sin daño.
    assert.strictEqual(guardado('39', '3931234567'), '3931234567',
        'un móvil italiano que empieza por 39 sale como entró');
    assert.strictEqual(guardado('34', '34600123456'), '34600123456');
});

test('quitar el tronco no puede romper un número que ya estaba bien', () => {
    // Noruega: ocho dígitos, sin tronco. Un «0…» de ocho dígitos no se toca —quitarle el 0
    // dejaría siete, que no es un largo válido— así que la reparación no se aplica.
    const noruega = PAISES.find(p => p.iso === 'NO');
    assert.deepStrictEqual(noruega.nsn, [8, 8]);
    assert.strictEqual(guardado('47', '12345678'), '4712345678');
    // Y el candado en general: si el número tal cual ya es de largo válido, se respeta.
    assert.strictEqual(guardado('34', '600123456'), '34600123456');
});

test('un número que no cuadra con NINGUNA reparación se rechaza, no se apaña', () => {
    // Regla 3: si no se resuelve, no se inventa. Un `null` aquí acaba en `datos_invalidos`,
    // que devuelve a la clienta al paso de sus datos con todo lo demás intacto.
    assert.strictEqual(guardado('34', '60012'), null, 'cinco dígitos no son un móvil');
    assert.strictEqual(guardado('34', ''), null);
    assert.strictEqual(guardado('34', 'mi movil'), null);
    assert.strictEqual(guardado('380', '12'), null);
    assert.strictEqual(componerTelefono({ prefijo: '34', numero: '60012' }).motivo, 'corto');
    assert.strictEqual(componerTelefono({ prefijo: '34', numero: '6001234567890' }).motivo, 'largo');
});

// ─── 4 · La puerta del '+': quien no está en la lista corta también reserva ──────────────

test('con «+» delante manda lo que ella escribió, aunque no sea el país del desplegable', () => {
    // Es lo que hace que una lista de 17 países no deje fuera a nadie: quien viene de
    // Georgia o de Colombia escribe su número entero y se le respeta.
    assert.strictEqual(guardado('34', '+995551234567'), '995551234567');
    assert.strictEqual(guardado('34', '00 995 551 234 567'), '995551234567');
    // Y si el país sí coincide, da igual por dónde entre: mismo resultado.
    assert.strictEqual(guardado('34', '+380671234567'), guardado('380', '671234567'));
});

test('el «+» tampoco deja pasar cualquier cosa', () => {
    assert.strictEqual(guardado('34', '+123'), null, 'tres dígitos no son un E.164');
    assert.strictEqual(guardado('34', '+1234567890123456'), null, 'dieciséis, tampoco');
});

// ─── 5 · El prefijo es un conjunto CERRADO ───────────────────────────────────────────────

test('un prefijo que no está en la tabla NO compone nada', () => {
    // Sin esto, `prefijo` es texto de internet pegado delante de un teléfono. La rama de
    // «sin prefijo» existe para UN caso —el bundle viejo en los minutos de un despliegue— y
    // se marca para que el handler lo registre en vez de tragárselo.
    for (const malo of ['999', '<script>', '3 4', '', null, undefined, {}]) {
        const r = componerTelefono({ prefijo: malo, numero: '600123456' });
        assert.strictEqual(r.sinPrefijo, true, JSON.stringify(malo));
        assert.strictEqual(r.telefono, '600123456', 'no se le pega nada delante');
    }
});

test('sin prefijo, la conducta es EXACTAMENTE la de ayer', () => {
    // Y por eso no se le tira la reserva a esa clienta: se hace lo de siempre y se registra.
    const r = componerTelefono({ prefijo: undefined, numero: '600123456' });
    assert.strictEqual(sanitizePhone(r.telefono), sanitizePhone('600123456'));
    assert.strictEqual(sanitizePhone(r.telefono), '34600123456');
});

// ─── 6 · Componer y sanear no se pisan ───────────────────────────────────────────────────

test('`sanitizePhone` es un NO-OP sobre todo lo que sale de componer', () => {
    // Es la garantía de que no se ha abierto un segundo camino de normalización. Lo que sale
    // de aquí lleva prefijo, así que MOVIL_ES_SIN_PREFIJO —que exige NUEVE dígitos exactos—
    // no puede casar nunca. Se sigue llamando a sanitizePhone porque es la función canónica
    // del repo, no porque haga falta.
    for (const p of PAISES) {
        for (const largo of [p.nsn[0], p.nsn[1]]) {
            const r = componerTelefono({ prefijo: p.codigo, numero: '1'.repeat(largo) });
            assert.ok(r.ok, `${p.iso}/${largo}`);
            assert.strictEqual(sanitizePhone(r.telefono), r.telefono,
                `${p.iso}: sanitizePhone ha cambiado «${r.telefono}»`);
        }
    }
});

test('componer dos veces da lo mismo que componer una', () => {
    for (const [pref, n] of [['34', '600123456'], ['380', '0671234567'], ['7', '89161234567']]) {
        const una = guardado(pref, n);
        assert.strictEqual(guardado(pref, una), una, `${pref}/${n}`);
    }
});

// ─── 7 · La tabla, y lo que de ella sale a internet ──────────────────────────────────────

test('la tabla está bien formada: cada país con su código, su ISO y su rango', () => {
    const vistos = new Set();
    for (const p of PAISES) {
        assert.ok(/^\d{1,4}$/.test(p.codigo), `código raro: ${p.codigo}`);
        assert.ok(/^[A-Z]{2}$/.test(p.iso), `ISO raro: ${p.iso}`);
        assert.ok(!vistos.has(p.codigo), `código repetido: ${p.codigo}`);
        vistos.add(p.codigo);
        assert.ok(Array.isArray(p.nsn) && p.nsn.length === 2, `${p.iso}: nsn`);
        assert.ok(p.nsn[0] > 0 && p.nsn[0] <= p.nsn[1], `${p.iso}: nsn al revés`);
        assert.ok(p.troncal === null || /^\d$/.test(p.troncal), `${p.iso}: troncal`);
        // El nombre NO está en la tabla: lo pone el navegador con Intl.DisplayNames, que es
        // correcto en los cuatro idiomas y no son 68 cadenas que traducir a mano.
        assert.strictEqual(p.nombre, undefined, `${p.iso}: el nombre no se guarda aquí`);
    }
});

test('España va PRIMERA y es el valor por defecto', () => {
    // No es estética: es el 95 % del tráfico y el que no puede costar un toque de más.
    assert.strictEqual(PAISES[0].codigo, PAIS_POR_DEFECTO);
    assert.strictEqual(PAISES[0].iso, 'ES');
    assert.strictEqual(paisesPublicos()[0].codigo, '34');
    // Y detrás las dos que trajeron el encargo.
    assert.deepStrictEqual(PAISES.slice(1, 3).map(p => p.iso), ['UA', 'RU']);
});

test('los países que Sante TIENE en su tabla de contactos están todos', () => {
    // Medido el 21/08/2026 contra producción. No es una lista de deseos: son los prefijos
    // que ya existen en `contacts.wa_phone`, y dejar fuera uno de ellos es dejar fuera a una
    // clienta que ya viene al salón.
    const enProduccion = ['34', '380', '1', '39', '44', '47', '41', '52', '7', '33', '32', '353', '31'];
    const tabla = new Set(PAISES.map(p => p.codigo));
    const faltan = enProduccion.filter(c => !tabla.has(c));
    assert.deepStrictEqual(faltan, [], `sin sitio en el desplegable: ${faltan.join(', ')}`);
});

test('al navegador NO le viajan las piezas de la composición', () => {
    // `troncal` y el máximo de `nsn` son de quien COMPONE, y quien compone es el servidor.
    // Dárselos a la pantalla es invitar a que un día los use, y entonces hay dos versiones
    // de esta regla: una que enseña un país y otra que compone otro.
    for (const p of paisesPublicos()) {
        assert.deepStrictEqual(Object.keys(p).sort(), ['codigo', 'iso', 'minimo']);
    }
    assert.strictEqual(paisesPublicos().length, PAISES.length, 'no se pierde ningún país por el camino');
    assert.strictEqual(paisesPublicos().find(p => p.iso === 'NO').minimo, 8,
        'el mínimo sí viaja: es lo que evita el viaje al servidor por un dígito que falta');
});

if (fallos) { console.error(`\n${fallos} fallo(s)`); process.exit(1); }
console.log('\nTeléfono del enlace público: todo en verde');
