/**
 * tests/reserva-web-limitador.test.js — El limitador por dentro, y los topes de la dueña.
 *
 * El limitador es el ÚNICO anillo que queda entre una página pública y la agenda del salón:
 * el código por WhatsApp se descartó el 19/08 y el tope de citas solo actúa una vez que ya
 * hay ficha y hueco. Si esto cuenta mal, no lo cuenta nadie.
 *
 * Aquí se prueba con el reloj INYECTADO en vez de dormir: los tests de este repo no esperan
 * (es lo que bajó la suite de 224 s a 60 s), y una ventana de una hora no se puede probar de
 * otra manera.
 *
 * ── Sabotajes medidos (20/08/2026) ───────────────────────────────────────────────────────
 *   1. la ventana no purga (los golpes viejos cuentan para siempre) ............. 2 rojos
 *   2. `consumir` mira sin apuntar cuando deniega ............................... 1 rojo
 *   3. `leerEntero` con `Number(v) || default` (el 0 se lee como «sin poner») ... 2 rojos
 *   4. sin tope de claves (el limitador como vector de memoria) ................. 1 rojo
 */
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const {
    crearLimitador, resolverLimites, LIMITES_DEFAULT, HORA_MS,
    enlaceWhatsApp, respuestaNo, MOTIVOS, POLITICA,
    catalogoPublico, limpiarUnaLinea, MAX_NOTAS,
} = require('../services/reserva-web');

function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

// ─── La ventana ──────────────────────────────────────────────────────────────────────────

test('deja pasar hasta el límite y para en el siguiente', () => {
    const lim = crearLimitador();
    const opts = { limite: 3 };
    assert.deepStrictEqual([1, 2, 3].map(() => lim.consumir('a', opts).permitido), [true, true, true]);
    assert.strictEqual(lim.consumir('a', opts).permitido, false);
});

test('la ventana se DESLIZA: vence cada golpe por su cuenta, no la ventana entera', () => {
    // Los dos golpes van SEPARADOS en el tiempo a propósito: si se dieran en el mismo
    // instante vencerían juntos y el bloque no distinguiría una ventana deslizante de una
    // que se vacía de golpe cada hora, que es otra cosa y se comporta distinto.
    let t = 1_000_000;
    const lim = crearLimitador({ ahora: () => t });
    const opts = { limite: 2 };
    lim.consumir('a', opts);              // golpe 1, en t
    t += 5 * 60 * 1000;
    lim.consumir('a', opts);              // golpe 2, cinco minutos después
    assert.strictEqual(lim.consumir('a', opts).permitido, false, 'debería estar agotada');

    // Un minuto antes de que el PRIMERO cumpla la hora: todavía no.
    t = 1_000_000 + HORA_MS - 60_000;
    assert.strictEqual(lim.consumir('a', opts).permitido, false, 'la ventana se ha soltado antes de tiempo');

    // Justo pasada la hora del primero: se libera UNO, y solo uno — el segundo aún vive.
    t = 1_000_000 + HORA_MS + 1;
    assert.strictEqual(lim.consumir('a', opts).permitido, true);
    assert.strictEqual(lim.consumir('a', opts).permitido, false, 'se han liberado más golpes de los que vencieron');
});

test('`esperaSegundos` dice cuánto falta de verdad', () => {
    let t = 0;
    const lim = crearLimitador({ ahora: () => t });
    lim.consumir('a', { limite: 1 });
    t += 10 * 60 * 1000;                       // han pasado 10 minutos
    const r = lim.consumir('a', { limite: 1 });
    assert.strictEqual(r.permitido, false);
    assert.strictEqual(r.esperaSegundos, 50 * 60, 'debería faltar lo que queda de hora, 50 min');
});

test('las claves NO se pisan entre sí: cada IP y cada org cuentan aparte', () => {
    const lim = crearLimitador();
    const opts = { limite: 1 };
    assert.strictEqual(lim.consumir('ip-1', opts).permitido, true);
    assert.strictEqual(lim.consumir('ip-2', opts).permitido, true);
    assert.strictEqual(lim.consumir('ip-1', opts).permitido, false);
});

test('un intento DENEGADO no alarga la condena: mirar no cuenta como golpe', () => {
    // Si cada intento denegado se apuntara, quien siga insistiendo se mantendría la ventana
    // llena para siempre y no saldría nunca — un castigo que nadie decidió.
    let t = 0;
    const lim = crearLimitador({ ahora: () => t });
    const opts = { limite: 1 };
    lim.consumir('a', opts);
    for (let i = 0; i < 50; i++) { t += 1000; lim.consumir('a', opts); }
    t = HORA_MS + 1;
    assert.strictEqual(lim.consumir('a', opts).permitido, true,
        'los intentos rechazados han ido renovando la ventana');
});

test('un límite de 0 CIERRA, y no se confunde con «no configurado»', () => {
    const lim = crearLimitador();
    assert.strictEqual(lim.consumir('a', { limite: 0 }).permitido, false);
});

test('el limitador no crece sin fin: es memoria del proceso de las DOS orgs', () => {
    const lim = crearLimitador({ maxClaves: 100 });
    for (let i = 0; i < 5000; i++) lim.consumir(`ip-${i}`, { limite: 3 });
    assert.ok(lim._claves() <= 100, `se guardan ${lim._claves()} claves: es un vector de memoria`);
});

test('al desalojar por tamaño se olvida a la MÁS ANTIGUA, no a la que está pegando ahora', () => {
    const lim = crearLimitador({ maxClaves: 2 });
    lim.consumir('vieja', { limite: 1 });
    lim.consumir('media', { limite: 1 });
    lim.consumir('nueva', { limite: 1 });      // desaloja a 'vieja'
    assert.strictEqual(lim.consumir('media', { limite: 1 }).permitido, false, 'se ha olvidado a la reciente');
    assert.strictEqual(lim.consumir('vieja', { limite: 1 }).permitido, true, 'la más antigua debería haber caído');
});

// ─── Los topes que edita la dueña ────────────────────────────────────────────────────────

test('sin config, los defaults del plan — y el interruptor APAGADO', () => {
    const l = resolverLimites({});
    assert.strictEqual(l.activo, false, 'el enlace no puede nacer encendido');
    assert.strictEqual(l.reservas_web_max_hora_ip, 3);
    assert.strictEqual(l.reservas_web_max_hora_org, 10);
    assert.strictEqual(l.reservas_web_max_futuras, 2);
});

test('un CERO de la dueña se respeta: es cerrar el grifo, no dejarlo sin poner', () => {
    const l = resolverLimites({ reservas_web_max_hora_ip: 0 });
    assert.strictEqual(l.reservas_web_max_hora_ip, 0, 'un 0 se ha leído como «usa el default»');
    assert.deepStrictEqual(l.invalidas, []);
});

test('`config` guarda TEXTO: un «3» es 3', () => {
    const l = resolverLimites({ reservas_web_max_hora_ip: '3', reservas_web_activo: 'true' });
    assert.strictEqual(l.reservas_web_max_hora_ip, 3);
    assert.strictEqual(l.activo, true);
});

test('un tope ilegible cae al default pero se DELATA', () => {
    const l = resolverLimites({ reservas_web_max_hora_ip: 'tres', reservas_web_activo: 'quizás' });
    assert.strictEqual(l.reservas_web_max_hora_ip, LIMITES_DEFAULT.reservas_web_max_hora_ip);
    assert.strictEqual(l.activo, false);
    assert.deepStrictEqual(l.invalidas.sort(), ['reservas_web_activo', 'reservas_web_max_hora_ip']);
});

test('las lecturas tienen su propio tope, muy por encima del de reservar', () => {
    const l = resolverLimites({});
    assert.ok(l.reservas_web_max_hora_lecturas_ip > l.reservas_web_max_hora_ip * 10,
        'con el cupo de reservas, pintar un mes rompería la página');
});

// ─── La política y sus salidas ───────────────────────────────────────────────────────────

test('TODOS los motivos tienen política: ninguno cae en un default', () => {
    for (const motivo of Object.values(MOTIVOS)) {
        if (motivo === MOTIVOS.OK) continue;
        assert.ok(POLITICA[motivo], `«${motivo}» no tiene política y caería en el genérico`);
    }
});

test('todo lo que la clienta no puede resolver sola lleva WhatsApp', () => {
    // La regla del encargo: un tope no puede parecer un error. Si no puede arreglarlo dándole
    // a otro hueco, tiene que poder hablar con una persona.
    for (const motivo of [MOTIVOS.TOPE_CITAS, MOTIVOS.NO_CONFIRMABLE_ONLINE, MOTIVOS.CERRADO,
                          MOTIVOS.DEMASIADAS_PETICIONES, MOTIVOS.SALON_SATURADO, MOTIVOS.ERROR_INTERNO]) {
        const { cuerpo } = respuestaNo(motivo, { waPhone: '34641029104', lang: 'es' });
        assert.ok(cuerpo.whatsapp, `«${motivo}» deja a la clienta sin salida`);
    }
});

test('lo que SÍ se arregla con otro hueco manda recargar, y no da la conversación', () => {
    for (const motivo of [MOTIVOS.HUECO_OCUPADO, MOTIVOS.HUECO_NO_EXISTE, MOTIVOS.BLOQUEADO]) {
        const { cuerpo } = respuestaNo(motivo, { waPhone: '34641029104', lang: 'es' });
        assert.strictEqual(cuerpo.recargarHuecos, true, `«${motivo}» debería recargar`);
    }
    // Y el tope, al revés: recargar sería enseñarle otra vez lo mismo.
    assert.strictEqual(respuestaNo(MOTIVOS.TOPE_CITAS, {}).cuerpo.recargarHuecos, false);
});

test('sin teléfono NO se fabrica un enlace roto', () => {
    assert.strictEqual(enlaceWhatsApp('', MOTIVOS.TOPE_CITAS, 'es'), null);
    assert.strictEqual(enlaceWhatsApp(null, MOTIVOS.TOPE_CITAS, 'es'), null);
    const { cuerpo } = respuestaNo(MOTIVOS.TOPE_CITAS, { waPhone: null, lang: 'es' });
    assert.ok(!('whatsapp' in cuerpo), 'se ha metido un enlace vacío en la respuesta');
});

test('el mensaje de WhatsApp va URL-encoded y en los cuatro idiomas', () => {
    for (const lang of ['es', 'en', 'ru', 'uk']) {
        const url = enlaceWhatsApp('+34 641 029 104', MOTIVOS.TOPE_CITAS, lang);
        assert.ok(url.startsWith('https://wa.me/34641029104?text='), `mal formado en ${lang}: ${url}`);
        assert.ok(!/[ \n]/.test(url), `el texto no está codificado en ${lang}`);
        assert.ok(decodeURIComponent(url.split('text=')[1]).length > 10);
    }
});

// ─── Las proyecciones ────────────────────────────────────────────────────────────────────

test('el catálogo público ENUMERA campos: lo que se añada al JSONB no sale solo', () => {
    const salida = catalogoPublico([
        { categoria: 'Cortes', nombre: 'Corte', precio: 35, duracion: 60,
          nota_interna: 'X', precio_coste: 12, proveedor: 'Y' },
    ]);
    assert.deepStrictEqual(salida, [{ categoria: 'Cortes', nombre: 'Corte', precio: 35, duracion: 60 }]);
});

test('un precio null se queda en null: un 0 € público es un precio inventado', () => {
    const [s] = catalogoPublico([{ categoria: 'Consulta', nombre: 'Valoración', precio: null, duracion: 20 }]);
    assert.strictEqual(s.precio, null);
    assert.notStrictEqual(s.precio, 0);
});

test('las notas entran acotadas y en UNA línea', () => {
    const sucia = `alergia al  amoniaco\n\nsegunda línea\ttab ${'x'.repeat(500)}`;
    const limpia = limpiarUnaLinea(sucia, MAX_NOTAS);
    assert.ok(limpia.length <= MAX_NOTAS);
    assert.ok(!/[\r\n\t]/.test(limpia), 'un salto de línea en un parámetro de plantilla hace que Meta rechace el mensaje entero');
    assert.ok(limpia.startsWith('alergia al amoniaco segunda línea tab'));
});
