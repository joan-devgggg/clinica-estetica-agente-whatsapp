/**
 * tests/reserva-web-pantalla.test.js — El núcleo de la PANTALLA pública de reserva.
 *
 * La pantalla vive en el Next (`dashboard-app`) y el resto de este repo no puede
 * `require()` un componente de React. Por eso todo lo que la pantalla DECIDE —qué texto sale
 * por cada motivo, a qué paso vuelve la clienta, cómo se agrupa el catálogo, qué días son
 * elegibles— está en UN fichero sin importaciones, `src/lib/reservar/nucleo.ts`, y este test
 * lo ejecuta de verdad aprovechando el borrado de tipos de Node 25.
 *
 * La alternativa era leer el TSX con un `grep`, que es lo que ya hace
 * `etiquetas-escalada-paridad` y que allí está bien porque lo que se vigila es una lista.
 * Aquí lo que se vigila es CONDUCTA: que un motivo desconocido no se pinte en crudo, que un
 * precio ausente no salga como 0 €, que un aviso no deje a la clienta sin salida. Eso un
 * grep no lo ve.
 *
 * ── LO QUE CRUZA, que es la razón de existir del fichero ─────────────────────────────────
 *
 * La política de los motivos (código HTTP, si se recargan los huecos, si se abre WhatsApp)
 * vive en `services/reserva-web.js` y VIAJA EN LA RESPUESTA. La pantalla no la copia: solo
 * pone el texto y el paso al que vuelve. Este test es lo que impide que las dos se separen:
 *
 *   · todo motivo de `MOTIVOS` tiene texto en la pantalla, y la pantalla no inventa ninguno;
 *   · si la política dice «recarga», la pantalla devuelve a un paso que se recarga;
 *   · si la política dice «no recarga», la pantalla NO la manda a los huecos;
 *   · un aviso sin salida (`vuelta: 'ninguna'`) solo se permite donde hay WhatsApp.
 *
 * ── Sabotajes medidos (20/08/2026) ───────────────────────────────────────────────────────
 *
 *   · borrar el texto de `tope_citas` de la tabla de la pantalla ................ 4 rojos
 *   · darle a `tope_citas` la vuelta 'huecos' (recargar tras el tope) ........... 2 rojos
 *   · que `interpretarFallo` acepte un motivo desconocido tal cual .............. 1 rojo
 *   · que `formatearPrecio` devuelva '0 €' cuando no hay precio ................. 1 rojo
 *   · que `construirMeses` marque elegible cualquier día no pasado .............. 2 rojos
 *   · que `hoyEnElSalon` use la hora del navegador (probado con TZ=UTC) ......... 1 rojo
 *   · que `agruparCatalogo` ordene los grupos alfabéticamente ................... 2 rojos
 */
const assert = require('assert');
const path = require('path');

const { MOTIVOS, POLITICA } = require('../services/reserva-web');
const N = require(path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'reservar', 'nucleo.ts'));

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

const T = N.textos('es');

// Los dos motivos que la pantalla conoce y `MOTIVOS` no, cada uno con su razón:
//   · no_encontrado — lo sirve `noHayNada` (webhook.js) y lo repite la capa del Next cuando
//     no hay secreto configurado. No está en MOTIVOS porque no es una decisión de política:
//     es «aquí no hay nada», y a esa altura ni siquiera se sabe de qué salón se hablaba.
//   · sin_conexion  — no lo manda nadie. Lo pone la pantalla cuando el fetch no llega a
//     contestar (el móvil en el ascensor), que es el caso que dejaría la página en blanco.
const SOLO_DE_LA_PANTALLA = ['no_encontrado', 'sin_conexion'];

// ─── 1 · Paridad con el conjunto cerrado del servidor ────────────────────────────────────

test('la pantalla tiene texto para TODOS los motivos que el servidor puede devolver', () => {
    const delServidor = Object.values(MOTIVOS).filter(m => m !== MOTIVOS.OK);
    const faltan = delServidor.filter(m => !T.motivos[m]);
    assert.deepStrictEqual(faltan, [],
        `la clienta vería el motivo en crudo o una pantalla muda: ${faltan.join(', ')}`);
});

test('la pantalla no se inventa motivos que nadie manda', () => {
    const conocidos = new Set([...Object.values(MOTIVOS), ...SOLO_DE_LA_PANTALLA]);
    const sobran = Object.keys(T.motivos).filter(m => !conocidos.has(m));
    assert.deepStrictEqual(sobran, [],
        `texto muerto: nadie puede llegar a leerlo (${sobran.join(', ')})`);
});

test('cada texto de motivo está completo: título, cuerpo y a dónde vuelve', () => {
    const VUELTAS = ['huecos', 'dias', 'servicio', 'datos', 'reintentar', 'ninguna'];
    for (const [motivo, texto] of Object.entries(T.motivos)) {
        assert.ok(texto.titulo && texto.titulo.trim(), `${motivo} sin título`);
        assert.ok(texto.cuerpo && texto.cuerpo.trim(), `${motivo} sin cuerpo`);
        assert.ok(VUELTAS.includes(texto.vuelta), `${motivo} vuelve a un paso que no existe: ${texto.vuelta}`);
    }
});

// ─── 2 · El cruce con la política, que es lo que impide que se separen ───────────────────

test('si la política RECARGA, la pantalla devuelve a un paso que se recarga', () => {
    // Recargar y quedarse en la pantalla de datos sería pedir los huecos y no enseñarlos.
    const mal = Object.entries(POLITICA)
        .filter(([, p]) => p.recargar)
        .filter(([m]) => T.motivos[m] && !['huecos', 'dias'].includes(T.motivos[m].vuelta));
    assert.deepStrictEqual(mal.map(([m]) => m), [],
        'la respuesta manda recargar huecos y la pantalla no lleva a ningún paso que los enseñe');
});

test('si la política NO recarga, la pantalla no la manda a los huecos', () => {
    // Es el caso `tope_citas`: enseñarle otra vez las horas que acaba de no poder reservar.
    const mal = Object.entries(POLITICA)
        .filter(([, p]) => !p.recargar)
        .filter(([m]) => T.motivos[m] && T.motivos[m].vuelta === 'huecos');
    assert.deepStrictEqual(mal.map(([m]) => m), [],
        'la pantalla enseñaría de nuevo unos huecos que la respuesta ha dicho que no recargue');
});

test('un aviso SIN SALIDA solo se permite donde hay WhatsApp', () => {
    const sinSalida = Object.entries(T.motivos)
        .filter(([, t]) => t.vuelta === 'ninguna')
        .map(([m]) => m)
        // `no_encontrado` es la excepción declarada: a esa altura no se sabe ni de qué salón
        // se hablaba, así que no hay número al que mandarla.
        .filter(m => m !== 'no_encontrado');
    const huerfanos = sinSalida.filter(m => !(POLITICA[m] && POLITICA[m].whatsapp));
    assert.deepStrictEqual(huerfanos, [],
        `callejón sin salida: aviso terminal y ningún botón (${huerfanos.join(', ')})`);
});

test('el tope de citas: no recarga, y la salida es WhatsApp', () => {
    // El punto 3 del encargo, fila por fila. Es la única política de las cuatro del SQL que
    // no es un error de agenda, y por eso es la que se pinta distinto.
    assert.strictEqual(POLITICA[MOTIVOS.TOPE_CITAS].recargar, false);
    assert.strictEqual(POLITICA[MOTIVOS.TOPE_CITAS].whatsapp, true);
    assert.strictEqual(T.motivos.tope_citas.vuelta, 'ninguna');
});

test('los cuatro motivos de `reservar_hueco()` se pintan cada uno a su manera', () => {
    const cuatro = ['hueco_ocupado', 'fuera_de_horario', 'bloqueado', 'tope_citas'];
    const titulos = cuatro.map(m => T.motivos[m].titulo);
    assert.strictEqual(new Set(titulos).size, 4,
        'dos de los cuatro dicen lo mismo: la clienta no sabría qué ha pasado');
    // Los tres de agenda recargan; el tope no. Es la raya del punto 3 del encargo.
    assert.deepStrictEqual(cuatro.map(m => POLITICA[m].recargar), [true, true, true, false]);
});

// ─── 3 · Leer una respuesta que dice que no ──────────────────────────────────────────────

test('un motivo DESCONOCIDO cae en error_interno, nunca se pinta en crudo', () => {
    const f = N.interpretarFallo(409, { ok: false, motivo: 'motivo_del_futuro' });
    assert.strictEqual(f.motivo, 'error_interno');
    assert.ok(T.motivos[f.motivo], 'error_interno tiene que tener texto: es la red de todo lo demás');
});

test('un cuerpo que no se entiende tampoco deja la pantalla muda', () => {
    for (const cuerpo of [null, undefined, '', '<html>502 Bad Gateway</html>', 0, []]) {
        const f = N.interpretarFallo(502, cuerpo);
        assert.strictEqual(f.motivo, 'error_interno', `cuerpo ${JSON.stringify(cuerpo)}`);
        assert.strictEqual(f.recargarHuecos, false);
        assert.strictEqual(f.whatsapp, null);
    }
});

test('recargarHuecos solo es true si la respuesta lo dice con un true', () => {
    assert.strictEqual(N.interpretarFallo(409, { motivo: 'hueco_ocupado', recargarHuecos: true }).recargarHuecos, true);
    for (const v of ['true', 1, {}, undefined, null]) {
        assert.strictEqual(
            N.interpretarFallo(409, { motivo: 'hueco_ocupado', recargarHuecos: v }).recargarHuecos, false,
            `un ${JSON.stringify(v)} se ha leído como «recarga»`);
    }
});

test('el enlace de WhatsApp se comprueba antes de meterlo en un href', () => {
    const bueno = 'https://wa.me/34641029104?text=hola';
    assert.strictEqual(N.interpretarFallo(409, { motivo: 'tope_citas', whatsapp: bueno }).whatsapp, bueno);
    for (const malo of ['javascript:alert(1)', 'http://wa.me/34', '/otra-cosa', 42, null]) {
        assert.strictEqual(N.interpretarFallo(409, { motivo: 'tope_citas', whatsapp: malo }).whatsapp, null,
            `se habría pintado un href con ${JSON.stringify(malo)}`);
    }
});

test('la espera se dice en minutos cuando es larga, y nunca cuando no la hay', () => {
    assert.strictEqual(N.textoEspera(T, null), null);
    assert.strictEqual(N.textoEspera(T, 0), null);
    assert.strictEqual(N.textoEspera(T, -5), null);
    assert.ok(N.textoEspera(T, 30).includes('30'));
    assert.ok(N.textoEspera(T, 3600).includes('60'));
    // Y el marcador de la plantilla no puede quedarse sin sustituir en pantalla.
    assert.ok(!N.textoEspera(T, 3600).includes('{'), 'ha salido un {min} sin rellenar');
});

// ─── 4 · El catálogo ─────────────────────────────────────────────────────────────────────

const CATALOGO = [
    { key: 'Cortes|Corte mujer', categoria: 'Cortes', nombre: 'Corte mujer', precio: 35, duracion: 60 },
    { key: 'Cortes|Corte hombre', categoria: 'Cortes', nombre: 'Corte hombre', precio: 25, duracion: 30 },
    { key: 'Mechas Balayage|Cabello corto', categoria: 'Mechas Balayage', nombre: 'Cabello corto', precio: 180, duracion: 240 },
    { key: 'Mechas Balayage|Cabello largo', categoria: 'Mechas Balayage', nombre: 'Cabello largo', precio: 200, duracion: 240 },
    { key: 'Brillo Glow|Brillo Glow', categoria: 'Brillo Glow', nombre: 'Brillo Glow', precio: null, duracion: 45 },
];

test('agrupa por categoría y conserva el ORDEN del servidor', () => {
    const { grupos } = N.agruparCatalogo(CATALOGO);
    assert.deepStrictEqual(grupos.map(g => g.categoria), ['Cortes', 'Mechas Balayage', 'Brillo Glow'],
        'el orden es el que la dueña ve en el panel: reordenarlo aquí es reordenarle el escaparate');
    assert.deepStrictEqual(grupos.map(g => g.entradas.length), [2, 2, 1]);
});

test('«desde» es el precio más bajo, y una entrada sin precio se marca aparte', () => {
    const { grupos } = N.agruparCatalogo(CATALOGO);
    assert.strictEqual(grupos[0].desde, 25);
    assert.strictEqual(grupos[1].desde, 180);
    assert.strictEqual(grupos[2].desde, null);
    assert.strictEqual(grupos[2].algunoSinPrecio, true);
    assert.strictEqual(grupos[0].algunoSinPrecio, false);
});

test('una entrada sin clave se DESCARTA y se cuenta: sería un botón que no lleva a nada', () => {
    const { grupos, descartadas } = N.agruparCatalogo([
        ...CATALOGO,
        { categoria: 'Color', nombre: 'Sin clave', precio: 50, duracion: 60 },
        { key: 'X|Y', nombre: 'Sin categoría', precio: 10 },
        'esto no es un servicio',
    ]);
    assert.strictEqual(descartadas, 3);
    assert.ok(!grupos.some(g => g.categoria === 'Color'));
});

test('sin precio NO se pinta 0 € — se dice que se confirma en el salón', () => {
    // Regla 3, y en una página pública es peor que en un informe: un 0 € es un precio.
    const salida = N.formatearPrecio(null, T);
    assert.ok(!salida.includes('0'), `ha salido un precio inventado: ${salida}`);
    assert.strictEqual(salida, T.precioEnSalon);
    assert.strictEqual(N.formatearPrecio(35, T), '35 €');
    assert.strictEqual(N.formatearPrecio(19.5, T), '19,50 €');
});

test('la duración: minutos, horas, y null cuando no la hay', () => {
    assert.strictEqual(N.formatearDuracion(45, T), '45 min');
    assert.strictEqual(N.formatearDuracion(240, T), '4 h');
    assert.strictEqual(N.formatearDuracion(270, T), '4 h 30 min');
    assert.strictEqual(N.formatearDuracion(null, T), null);
    assert.strictEqual(N.formatearDuracion(0, T), null);
});

// ─── 5 · La rejilla de días ──────────────────────────────────────────────────────────────

test('solo es elegible el día que el SERVIDOR ha devuelto con huecos', () => {
    const meses = N.construirMeses('2026-08-20', 90, [
        { fecha: '2026-08-25', huecos: 3 },
        { fecha: '2026-09-01', huecos: 1 },
        { fecha: '2026-09-02', huecos: 0 },   // devuelto pero vacío: no se puede elegir
    ]);
    const elegibles = meses.flatMap(m => m.casillas).filter(c => c.elegible).map(c => c.fecha);
    assert.deepStrictEqual(elegibles, ['2026-08-25', '2026-09-01'],
        'la rejilla está DEDUCIENDO disponibilidad en vez de pintar la que le dan');
});

test('la rejilla llega hasta el final del horizonte y no más', () => {
    const meses = N.construirMeses('2026-08-20', 90, []);
    assert.deepStrictEqual(meses.map(m => `${m.anio}-${m.mes + 1}`),
        ['2026-8', '2026-9', '2026-10', '2026-11']);
});

test('la semana empieza en LUNES, como stylist_schedules', () => {
    // 1 de febrero de 2026 cae en DOMINGO: seis casillas de relleno antes del día 1.
    const [febrero] = N.construirMeses('2026-02-01', 0, []);
    const relleno = febrero.casillas.filter(c => c.fecha === null).length;
    assert.strictEqual(relleno, 6, 'la rejilla empezaría en domingo y todo el mes saldría corrido');
    assert.strictEqual(febrero.casillas[6].dia, 1);
    assert.strictEqual(febrero.casillas.length, 6 + 28);
});

test('el primer mes con hueco se encuentra, y -1 cuando no hay ninguno', () => {
    const conHueco = N.construirMeses('2026-08-20', 90, [{ fecha: '2026-10-05', huecos: 2 }]);
    assert.strictEqual(N.primerMesConHueco(conHueco), 2);
    assert.strictEqual(N.primerMesConHueco(N.construirMeses('2026-08-20', 90, [])), -1);
});

test('una fecha ilegible no revienta la rejilla: devuelve vacío', () => {
    assert.deepStrictEqual(N.construirMeses('20 de agosto', 90, []), []);
    assert.deepStrictEqual(N.construirMeses('2026-02-31', 90, []), []);
});

test('el HOY es el del salón, no el del móvil de la clienta', () => {
    // 20/08 a las 23:30 UTC ya es el 21 en Madrid. Con el reloj del navegador, una clienta en
    // Londres vería el calendario corrido un día y pediría una fecha que aquí ya pasó.
    assert.strictEqual(N.hoyEnElSalon(new Date('2026-08-20T23:30:00Z')), '2026-08-21');
    assert.strictEqual(N.hoyEnElSalon(new Date('2026-08-20T21:30:00Z')), '2026-08-20');
    // Y en invierno, con una hora menos de diferencia.
    assert.strictEqual(N.hoyEnElSalon(new Date('2026-01-01T23:30:00Z')), '2026-01-02');
});

// ─── 6 · Los idiomas: la estructura está, las traducciones no ────────────────────────────

test('los cuatro idiomas devuelven una tabla ENTERA, hoy la castellana', () => {
    for (const lang of N.IDIOMAS) {
        const t = N.textos(lang);
        assert.ok(t && t.titulo && t.motivos && t.motivos.tope_citas,
            `${lang} devuelve una tabla incompleta: la pantalla saldría con huecos`);
    }
    // Un idioma que no existe cae igual, no revienta.
    assert.strictEqual(N.textos('zz').titulo, T.titulo);
    assert.strictEqual(N.textos(undefined).titulo, T.titulo);
    assert.strictEqual(N.idiomaValido('ru'), 'ru');
    assert.strictEqual(N.idiomaValido('zz'), 'es');
});

test('ni una cadena vacía en la tabla castellana', () => {
    const vacias = [];
    for (const [clave, valor] of Object.entries(T)) {
        if (typeof valor === 'string' && !valor.trim()) vacias.push(clave);
    }
    assert.deepStrictEqual(vacias, [], `saldría un hueco en pantalla: ${vacias.join(', ')}`);
    assert.strictEqual(T.meses.length, 12);
    assert.strictEqual(T.inicialesDias.length, 7);
    assert.strictEqual(T.inicialesDias[0], 'L', 'la primera columna de la rejilla es lunes');
});

test('la confirmación nombra el salón, y aguanta no saber cómo se llama', () => {
    assert.ok(T.confirmadaTitulo.includes('{salon}'));
    assert.strictEqual(N.rellenar(T.confirmadaTitulo, { salon: 'Sante' }),
        'Tu cita ha sido confirmada en Sante');
    // Sin nombre no se rellena con una cadena vacía dejando «confirmada en .»: hay otra frase.
    assert.ok(!T.confirmadaSinSalon.includes('{'));
    assert.ok(/recordatorio/i.test(T.avisoRecordatorio) && /24/.test(T.avisoRecordatorio));
});

// ─── 7 · Lo que teclea la clienta ────────────────────────────────────────────────────────

test('el teléfono se comprueba flojo a propósito: el servidor tiene la última palabra', () => {
    assert.ok(N.telefonoUsable('600 11 22 33'));
    assert.ok(N.telefonoUsable('+34 600112233'));
    assert.ok(N.telefonoUsable('+380 67 123 4567'), 'un número ucraniano tiene que poder reservar');
    assert.ok(!N.telefonoUsable('60011'));
    assert.ok(!N.telefonoUsable(''));
    assert.ok(!N.telefonoUsable('1234567890123456789'));
    assert.ok(N.nombreUsable('Ana'));
    assert.ok(!N.nombreUsable(' '));
    assert.ok(!N.nombreUsable('A'));
});

process.exit(fallos ? 1 : 0);
