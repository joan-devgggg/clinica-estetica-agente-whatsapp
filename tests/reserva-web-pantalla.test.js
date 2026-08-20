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
 *
 * Y los de los CUATRO IDIOMAS (21/08/2026), cada uno con su bloque y ninguno solapado:
 *   · dejar una cadena del ruso en castellano ................................... 1 rojo
 *     (y el rojo dice la ruta y el valor: «ru: confirmar = "Confirmar la cita"»)
 *   · copiar la tabla rusa entera en la ucraniana ............................... 1 rojo
 *   · quitarle una clave al inglés .............................................. 1 rojo
 *   · perder el `{salon}` al traducir el título de la confirmación .............. 1 rojo
 *   · escribir un mensaje de WhatsApp en la tabla de textos ..................... 1 rojo
 *   · que el navegador gane a la `?lang=` de la URL ............................. 1 rojo
 *
 * Y los del NOMBRE del servicio y el TELÉFONO (21/08/2026):
 *   · que la pantalla vuelva a componer «categoría · nombre» .................... 3 rojos
 *   · que el título del paso 1 ignore el grupo de una sola entrada .............. 2 rojos
 *   · que las letras de un teléfono no se distingan de un dígito que falta ...... 1 rojo
 *   · que las letras entren en el VEREDICTO y endurezcan quién puede reservar ... 1 rojo
 *
 * Y los del ATRÁS y la RECARGA (21/08/2026), que es el grupo grande:
 *   · dar por bueno el hueco recuperado sin volver a preguntar al motor ......... 2 rojos
 *   · que una fecha ya pasada tire el progreso entero en vez de degradarlo ...... 1 rojo
 *   · leer una petición de huecos ROTA como «ese día está vacío» ................ 1 rojo
 *   · no recortar el paso que pide el ADELANTE del navegador .................... 1 rojo
 *   · que retroceder al día se deje la hora puesta .............................. 1 rojo
 *   · meter el paso en la URL (el enlace a medias que se puede reenviar) ........ 1 rojo
 *   · que la secuencia lleve siempre el paso de la variante ..................... 1 rojo
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
//   · hueco_caducado — tampoco lo manda nadie. Lo pone la pantalla al VOLVER de una recarga
//     cuando el hueco que ella tenía elegido ya no está en la lista que el motor acaba de
//     dar. Es un veredicto sobre la agenda, no una política: la vuelta la decide `vueltaDe`
//     como con todos los demás.
const SOLO_DE_LA_PANTALLA = ['no_encontrado', 'sin_conexion', 'hueco_caducado'];

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
        assert.ok(VUELTAS.includes(N.vueltaDe(motivo)), `${motivo} vuelve a un paso que no existe`);
    }
});

// ─── 2 · El cruce con la política, que es lo que impide que se separen ───────────────────

test('si la política RECARGA, la pantalla devuelve a un paso que se recarga', () => {
    // Recargar y quedarse en la pantalla de datos sería pedir los huecos y no enseñarlos.
    const mal = Object.entries(POLITICA)
        .filter(([, p]) => p.recargar)
        .filter(([m]) => T.motivos[m] && !['huecos', 'dias'].includes(N.vueltaDe(m)));
    assert.deepStrictEqual(mal.map(([m]) => m), [],
        'la respuesta manda recargar huecos y la pantalla no lleva a ningún paso que los enseñe');
});

test('si la política NO recarga, la pantalla no la manda a los huecos', () => {
    // Es el caso `tope_citas`: enseñarle otra vez las horas que acaba de no poder reservar.
    const mal = Object.entries(POLITICA)
        .filter(([, p]) => !p.recargar)
        .filter(([m]) => T.motivos[m] && N.vueltaDe(m) === 'huecos');
    assert.deepStrictEqual(mal.map(([m]) => m), [],
        'la pantalla enseñaría de nuevo unos huecos que la respuesta ha dicho que no recargue');
});

test('un aviso SIN SALIDA solo se permite donde hay WhatsApp', () => {
    const sinSalida = Object.keys(T.motivos)
        .filter(m => N.vueltaDe(m) === 'ninguna')
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
    assert.strictEqual(N.vueltaDe('tope_citas'), 'ninguna');
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

test('el fetch que no llega a contestar tiene su propio motivo, con texto', () => {
    const f = N.falloSinConexion();
    assert.strictEqual(f.motivo, 'sin_conexion');
    assert.strictEqual(f.recargarHuecos, false);
    assert.ok(T.motivos.sin_conexion.titulo, 'la pantalla se quedaría en blanco al caerse la red');
    assert.strictEqual(N.vueltaDe('sin_conexion'), 'reintentar');
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

test('el WhatsApp de respaldo NO se cuela en un «no» que el servidor ya contestó', () => {
    // Fallo real cazado el 20/08 mirando la pantalla: `hueco_ocupado` salía con botón de
    // WhatsApp. Su política dice `whatsapp: false` porque lo que esa clienta tiene que hacer
    // es tocar otra hora, que la tiene delante — el botón la sacaba de la página.
    const respaldo = 'https://wa.me/34641029104?text=hola';
    const ocupado = N.interpretarFallo(409, { motivo: 'hueco_ocupado', recargarHuecos: true });
    assert.strictEqual(N.enlaceDelAviso(ocupado, respaldo), null,
        'el respaldo se salta la política del servidor por arriba');

    // Y donde el servidor SÍ manda enlace, se usa el suyo, no el de respaldo.
    const suyo = 'https://wa.me/34641029104?text=tengo%20dos';
    const tope = N.interpretarFallo(409, { motivo: 'tope_citas', whatsapp: suyo });
    assert.strictEqual(N.enlaceDelAviso(tope, respaldo), suyo);
});

test('cuando NO hubo respuesta que obedecer, el respaldo es lo único que queda', () => {
    const respaldo = 'https://wa.me/34641029104?text=hola';
    // Red caída y cuerpo ilegible: los dos son «de la pantalla», y sin el respaldo la
    // clienta se queda con un aviso y ninguna salida.
    assert.strictEqual(N.enlaceDelAviso(N.falloSinConexion(), respaldo), respaldo);
    assert.strictEqual(N.enlaceDelAviso(N.interpretarFallo(502, '<html>502</html>'), respaldo), respaldo);
    assert.strictEqual(N.enlaceDelAviso(N.interpretarFallo(409, { motivo: 'del_futuro' }), respaldo), respaldo);
    // Sin respaldo tampoco se inventa nada.
    assert.strictEqual(N.enlaceDelAviso(N.falloSinConexion(), null), null);
});

test('el 502 del PUENTE se reconoce como propio y recupera la salida por WhatsApp', () => {
    // El Route Handler del Next fabrica `{motivo:'error_interno'}` cuando Express no
    // contesta. Ese cuerpo NO ha pasado por la política, así que no lleva `whatsapp` — y sin
    // la marca `origen:'puente'` la pantalla decía «escríbenos por WhatsApp» sin un botón al
    // que escribir. Cazado el 20/08 mirando la pantalla con Express caído.
    const respaldo = 'https://wa.me/34641029104?text=hola';
    const delPuente = N.interpretarFallo(502, { ok: false, motivo: 'error_interno', origen: 'puente' });
    assert.strictEqual(delPuente.deLaPantalla, true);
    assert.strictEqual(N.enlaceDelAviso(delPuente, respaldo), respaldo);

    // Y el error_interno que sí viene de Express trae el suyo y no toca el respaldo.
    const deExpress = N.interpretarFallo(500, { ok: false, motivo: 'error_interno', whatsapp: 'https://wa.me/34641029104?text=ay' });
    assert.strictEqual(deExpress.deLaPantalla, false);
    assert.strictEqual(N.enlaceDelAviso(deExpress, respaldo), 'https://wa.me/34641029104?text=ay');
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

test('al ABRIR la página el aviso no habla de confirmar una cita que no existe', () => {
    // Con Express caído, la primera llamada falla y no hay formulario detrás. Decir «no
    // hemos podido confirmar la cita» es mentira —no había cita ninguna— y encima remite a
    // un WhatsApp que venía justo en la respuesta que ha fallado.
    const roto = N.interpretarFallo(502, { motivo: 'error_interno', origen: 'puente' });
    const enCarga = N.textoDelAviso(T, roto, { enCarga: true });
    assert.strictEqual(enCarga.titulo, T.noSeHaPodidoAbrir.titulo);
    assert.ok(!/confirmar/i.test(enCarga.titulo + enCarga.cuerpo),
        `dice que no ha podido confirmar algo que nadie llegó a pedir: ${enCarga.titulo}`);
    // Reservando sí es el texto del motivo.
    assert.strictEqual(N.textoDelAviso(T, roto).titulo, T.motivos.error_interno.titulo);
    // Y los motivos con contenido propio se dicen igual en los dos sitios.
    for (const m of ['cerrado', 'no_encontrado']) {
        const f = N.interpretarFallo(503, { motivo: m });
        assert.strictEqual(N.textoDelAviso(T, f, { enCarga: true }).titulo, T.motivos[m].titulo);
    }
});

// ─── 3 bis · El salón y sus dos puertas ──────────────────────────────────────────────────

test('leerSalon comprueba los enlaces antes de que lleguen a un href', () => {
    const bueno = N.leerSalon({
        nombre: '  Sante  ', direccion: 'Calle San Juan Bosco 14',
        whatsapp: 'https://wa.me/34641029104?text=a',
        puertas: { asesoramiento: 'https://wa.me/34641029104?text=b', varias_personas: 'https://wa.me/34641029104?text=c' },
    });
    assert.strictEqual(bueno.nombre, 'Sante');
    assert.strictEqual(bueno.direccion, 'Calle San Juan Bosco 14');
    assert.strictEqual(bueno.puertas.variasPersonas, 'https://wa.me/34641029104?text=c');

    const malo = N.leerSalon({
        nombre: '   ', whatsapp: 'javascript:alert(1)',
        puertas: { asesoramiento: '/algo', varias_personas: 42 },
    });
    assert.deepStrictEqual(malo, N.SALON_VACIO,
        'un enlace que no es wa.me ha llegado hasta el href');
    // Y una respuesta sin `salon` no revienta la página.
    assert.deepStrictEqual(N.leerSalon(undefined), N.SALON_VACIO);
});

test('las dos puertas tienen etiqueta, y dicen lo que hacen', () => {
    // Son las dos salidas que el formulario NO sabe hacer. Si alguien las deja sin texto,
    // salen dos botones mudos en la primera pantalla que ve la clienta.
    assert.ok(T.puertaAsesoramiento.trim().length > 5);
    assert.ok(T.puertaVariasPersonas.trim().length > 5);
    assert.ok(T.otrasOpciones.trim().length > 3);
    assert.notStrictEqual(T.puertaAsesoramiento, T.puertaVariasPersonas);
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

test('los meses que se pueden hojear salen de la RESPUESTA, no de un 90 copiado', () => {
    // El horizonte lo decide el servidor (HORIZONTE_RESERVA_WEB). Copiarlo aquí sería una
    // segunda constante, y el síntoma de que se separasen serían meses que no se pueden tocar.
    const cerca = N.mesesConDisponibilidad('2026-08-20', [{ fecha: '2026-08-28', huecos: 2 }]);
    assert.deepStrictEqual(cerca.map(m => `${m.anio}-${m.mes + 1}`), ['2026-8']);

    const lejos = N.mesesConDisponibilidad('2026-08-20', [
        { fecha: '2026-08-28', huecos: 2 }, { fecha: '2026-11-03', huecos: 1 },
    ]);
    assert.deepStrictEqual(lejos.map(m => `${m.anio}-${m.mes + 1}`), ['2026-8', '2026-9', '2026-10', '2026-11']);

    // Sin nada disponible se pinta el mes en curso: un calendario vacío se entiende, un
    // hueco en la página no.
    const vacio = N.mesesConDisponibilidad('2026-08-20', []);
    assert.strictEqual(vacio.length, 1);
    assert.ok(vacio[0].casillas.every(c => !c.elegible));
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

// ─── 6 bis · Las DOS formas del día, que son dos a propósito ─────────────────────────────

test('el rótulo suelto va en NOMINATIVO y la frase del servidor en acusativo', () => {
    // CLAUDE.md: el día de la semana se dice en UN solo sitio (`formatReminderWhen`). Esto no
    // lo incumple, y este bloque es la prueba de por qué: son dos FORMAS de la misma palabra.
    // Detrás de la preposición el ruso pide acusativo y el martes cambia hasta la preposición
    // («во вторник»); un rótulo encima de una rejilla de horas no lleva preposición ninguna y
    // va en nominativo, que es justo lo que `Intl` devuelve. Copiar la tabla del servidor
    // aquí pondría «во вторник» de título, o sea una frase a medias.
    const { formatReminderWhen } = require('../services/helpers');
    const casos = {
        es: ['martes', 'del martes'],
        ru: ['вторник', 'во вторник'],
        uk: ['вівторок', 'у вівторок'],
    };
    for (const [lang, [nominativo, conPreposicion]] of Object.entries(casos)) {
        const rotulo = N.etiquetaDia('2026-08-25', lang);
        const frase = formatReminderWhen('2026-08-25', '10:00', lang);
        assert.ok(rotulo.includes(nominativo), `${lang}: el rótulo no está en nominativo (${rotulo})`);
        assert.ok(frase.includes(conPreposicion), `${lang}: la frase del servidor ha cambiado (${frase})`);
        // Y la comprobación que importa: el rótulo NO puede llevar la preposición dentro.
        if (lang !== 'es') {
            assert.ok(!rotulo.includes(conPreposicion),
                `${lang}: el rótulo lleva la preposición: es la tabla del servidor copiada`);
        }
    }
});

test('el rótulo del día lleva día de la semana, número y mes; y null si no se entiende', () => {
    const es = N.etiquetaDia('2026-08-25', 'es');
    assert.ok(/martes/.test(es) && /25/.test(es) && /agosto/.test(es), es);
    // en-GB y no en-US: «25 August», la misma decisión que REMINDER_DATE_LOCALE.
    assert.strictEqual(N.etiquetaDia('2026-08-25', 'en'), 'Tuesday 25 August');
    assert.strictEqual(N.etiquetaDia('2026-02-31', 'es'), null);
    assert.strictEqual(N.etiquetaDia('mañana', 'es'), null);
    // Y el mes de la rejilla, por el mismo camino.
    assert.ok(/agosto/.test(N.etiquetaMes(2026, 7, 'es')));
    assert.ok(/2026/.test(N.etiquetaMes(2026, 7, 'es')));
});

// ─── 6 ter · LOS CUATRO IDIOMAS, cadena por cadena ───────────────────────────────────────
//
// El fallo que esto caza no es una traducción mala: es una que NO SE HIZO. Cuatro tablas de
// ~60 cadenas, una debajo de otra, y la que se quedó en castellano no la ve nadie leyendo —
// la ve una clienta rusa en la pantalla de error, que es el peor momento posible.

/** Aplana una tabla a pares [ruta, cadena], entrando en objetos y arrays. */
function cadenasDe(obj, prefijo = '') {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        const ruta = prefijo ? `${prefijo}.${k}` : k;
        if (typeof v === 'string') out.push([ruta, v]);
        else if (Array.isArray(v)) v.forEach((x, i) => out.push([`${ruta}[${i}]`, x]));
        else if (v && typeof v === 'object') out.push(...cadenasDe(v, ruta));
    }
    return out;
}

// Las que PUEDEN coincidir con el castellano sin que sea un descuido. Cada una declarada:
// fuera y en silencio es como se cuela la que sí lo es.
const COINCIDEN_A_PROPOSITO = {
    en: new Set([
        'minutos',            // 'min' se abrevia igual
        'horas',              // 'h' también
        'inicialesDias[5]',   // sábado y Saturday empiezan por S
    ]),
    ru: new Set(),
    uk: new Set(),
};

test('los cuatro idiomas tienen EXACTAMENTE las mismas claves', () => {
    const rutasEs = cadenasDe(N.TEXTOS.es).map(([r]) => r).sort();
    for (const lang of ['en', 'ru', 'uk']) {
        const rutas = cadenasDe(N.TEXTOS[lang]).map(([r]) => r).sort();
        const faltan = rutasEs.filter(r => !rutas.includes(r));
        const sobran = rutas.filter(r => !rutasEs.includes(r));
        assert.deepStrictEqual(faltan, [], `${lang}: faltan ${faltan.join(', ')}`);
        assert.deepStrictEqual(sobran, [], `${lang}: sobran ${sobran.join(', ')}`);
    }
});

test('ni una cadena vacía en ninguno de los cuatro', () => {
    for (const lang of N.IDIOMAS) {
        const vacias = cadenasDe(N.TEXTOS[lang]).filter(([, v]) => !String(v).trim()).map(([r]) => r);
        assert.deepStrictEqual(vacias, [], `${lang}: saldría un hueco en pantalla (${vacias.join(', ')})`);
    }
});

test('NINGUNA cadena se ha quedado en castellano', () => {
    const es = new Map(cadenasDe(N.TEXTOS.es));
    for (const lang of ['en', 'ru', 'uk']) {
        const sinTraducir = cadenasDe(N.TEXTOS[lang])
            .filter(([ruta, v]) => v === es.get(ruta) && !COINCIDEN_A_PROPOSITO[lang].has(ruta))
            .map(([ruta, v]) => `${ruta} = ${JSON.stringify(v)}`);
        assert.deepStrictEqual(sinTraducir, [],
            `${lang}: se quedaron en castellano →\n     ${sinTraducir.join('\n     ')}`);
    }
});

test('el ucraniano no es el ruso copiado, y se demuestra por las letras', () => {
    // Misma técnica que `detectLanguage`: `і ї є ґ` existen en ucraniano y NO en ruso. Un
    // copia-pega de una tabla en la otra —en cualquiera de las dos direcciones— se cae aquí,
    // y no hace falta ningún umbral ni comparar cadena a cadena las que legítimamente
    // coinciden («Назад», «Пн», «День»…).
    const exclusivas = /[іїєґ]/i;
    const uk = cadenasDe(N.TEXTOS.uk).filter(([, v]) => exclusivas.test(v));
    assert.ok(uk.length > 15, `solo ${uk.length} cadenas ucranianas llevan і/ї/є/ґ: ¿es ruso?`);
    const ru = cadenasDe(N.TEXTOS.ru).filter(([, v]) => exclusivas.test(v)).map(([r]) => r);
    assert.deepStrictEqual(ru, [], `el ruso lleva letras ucranianas: ${ru.join(', ')}`);
    // Y el cirílico no se cuela en las dos latinas.
    for (const lang of ['es', 'en']) {
        const cirilico = cadenasDe(N.TEXTOS[lang]).filter(([, v]) => /[а-яёіїєґ]/i.test(v)).map(([r]) => r);
        assert.deepStrictEqual(cirilico, [], `${lang} lleva cirílico: ${cirilico.join(', ')}`);
    }
});

test('los marcadores de plantilla sobreviven a la traducción', () => {
    // Un `{salon}` perdido al traducir deja «Tu cita ha sido confirmada en» y punto.
    for (const lang of N.IDIOMAS) {
        const t = N.TEXTOS[lang];
        assert.ok(t.confirmadaTitulo.includes('{salon}'), `${lang}: confirmadaTitulo sin {salon}`);
        assert.ok(t.esperaMinutos.includes('{min}'), `${lang}: esperaMinutos sin {min}`);
        assert.ok(t.esperaSegundos.includes('{seg}'), `${lang}: esperaSegundos sin {seg}`);
        assert.ok(!t.confirmadaSinSalon.includes('{'), `${lang}: confirmadaSinSalon con marcador`);
        // Y ningún marcador huérfano en el resto: un `{min}` en una cadena que nadie rellena
        // sale tal cual en pantalla.
        const conLlaves = cadenasDe(t)
            .filter(([ruta, v]) => /\{\w+\}/.test(v)
                && !['confirmadaTitulo', 'esperaMinutos', 'esperaSegundos'].includes(ruta))
            .map(([ruta]) => ruta);
        assert.deepStrictEqual(conLlaves, [], `${lang}: marcadores que nadie rellena en ${conLlaves.join(', ')}`);
    }
});

test('la pantalla NO escribe ni un mensaje de WhatsApp: los redacta el servidor', () => {
    // Los de las dos puertas y los de cada motivo viven en `services/reserva-web.js`, ya en
    // cuatro idiomas, y llegan como URL montada. Una frase aquí sería la quinta traducción
    // de lo mismo, y la que nadie revisaría.
    for (const lang of N.IDIOMAS) {
        const sospechosas = cadenasDe(N.TEXTOS[lang])
            .filter(([, v]) => /wa\.me|https?:\/\//.test(v)).map(([r]) => r);
        assert.deepStrictEqual(sospechosas, [], `${lang}: la pantalla fabrica un enlace (${sospechosas.join(', ')})`);
    }
    // Y el único sitio del fichero donde aparece wa.me es la COMPROBACIÓN de lo que llega.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'reservar', 'nucleo.ts'), 'utf8');
    const apariciones = (src.match(/wa\.me/g) || []).length;
    assert.strictEqual(apariciones, 2,
        `wa.me aparece ${apariciones} veces en nucleo.ts: debería estar solo en las dos guardas de href`);
});

test('la conducta NO depende del idioma: `vuelta` vive en una sola tabla', () => {
    // Si `vuelta` estuviera dentro de cada tabla de idioma, cambiar una y no las otras haría
    // que la pantalla se COMPORTARA distinto en ruso. Eso ya no se puede escribir: no hay
    // dónde ponerlo.
    for (const lang of N.IDIOMAS) {
        const conVuelta = cadenasDe(N.TEXTOS[lang]).filter(([r]) => r.endsWith('.vuelta'));
        assert.deepStrictEqual(conVuelta, [], `${lang}: la conducta ha vuelto a la tabla de textos`);
    }
    assert.strictEqual(N.vueltaDe('hueco_ocupado'), 'huecos');
    assert.strictEqual(N.vueltaDe('un_motivo_que_no_existe'), 'reintentar',
        'un motivo desconocido tiene que caer en el mismo sitio que error_interno');
});

// ─── 6 quater · De dónde sale el idioma ──────────────────────────────────────────────────

test('la URL manda sobre el navegador: una ucraniana con el móvil en ruso', () => {
    // Es el caso que ordena toda la cascada. Si el navegador ganara, esa clienta no tendría
    // forma de leer la pantalla en su idioma, y existe.
    const r = N.elegirIdioma({ url: 'uk', aceptaIdiomas: 'ru-RU,ru;q=0.9' });
    assert.deepStrictEqual(r, { idioma: 'uk', origen: 'url' });
});

test('sin `lang` se usa el navegador, con su orden de preferencia', () => {
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: 'uk-UA,uk;q=0.9,ru;q=0.8' }).idioma, 'uk');
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: 'en-US,en;q=0.9' }).idioma, 'en');
    // `ru,uk;q=0.9` es lo que manda Chrome cuando el sistema está en ruso: gana ruso.
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: 'ru,uk;q=0.9' }).idioma, 'ru');
    // Y la `q` manda sobre el orden: el francés no lo hablamos, el inglés sí.
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: 'fr-FR,fr;q=0.9,en;q=0.5' }).idioma, 'en');
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: 'uk-UA,uk;q=0.9,ru;q=0.8' }).origen, 'navegador');
});

test('un `lang` que no existe NO cae a castellano: sigue la cascada', () => {
    // Un enlace mal copiado («?lang=rus») no puede dejar a una rusa en castellano teniendo
    // el navegador en ruso.
    assert.strictEqual(N.elegirIdioma({ url: 'rus', aceptaIdiomas: 'ru-RU,ru;q=0.9' }).idioma, 'ru');
    assert.strictEqual(N.elegirIdioma({ url: '', aceptaIdiomas: 'uk' }).idioma, 'uk');
    assert.strictEqual(N.elegirIdioma({ url: 42, aceptaIdiomas: 'en' }).idioma, 'en');
});

test('sin ninguna señal, castellano — y se dice que es el default', () => {
    assert.deepStrictEqual(N.elegirIdioma({}), { idioma: 'es', origen: 'defecto' });
    assert.deepStrictEqual(N.elegirIdioma(), { idioma: 'es', origen: 'defecto' });
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: 'zh-CN,zh;q=0.9,ja;q=0.8' }).idioma, 'es');
    // Una cabecera basura no revienta la página.
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: ';;;q=' }).idioma, 'es');
    assert.strictEqual(N.elegirIdioma({ aceptaIdiomas: 'ru;q=0' }).idioma, 'es', 'q=0 significa «no quiero éste»');
});

test('el nombre de cada idioma va en SU idioma, y no se traduce', () => {
    assert.deepStrictEqual(N.NOMBRES_IDIOMA,
        { es: 'Español', en: 'English', ru: 'Русский', uk: 'Українська' });
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

test('un teléfono con LETRAS no se cuenta como dígitos que faltan', () => {
    // El bug: «600ABC123» decía «parece que falta algún dígito», y quien lo lee repasa las
    // cifras una por una sin ver lo que sobra.
    assert.strictEqual(N.problemaTelefono('600ABC123'), 'letras');
    assert.strictEqual(N.problemaTelefono('mi movil'), 'letras');
    assert.strictEqual(N.problemaTelefono('600 11 22 3O'), 'letras', 'una O en vez de un cero');
    assert.strictEqual(N.problemaTelefono('60011'), 'corto');
    assert.strictEqual(N.problemaTelefono(''), 'corto');
    assert.strictEqual(N.problemaTelefono('1234567890123456789'), 'largo');
    assert.strictEqual(N.problemaTelefono('600 11 22 33'), null);
});

test('los separadores que la gente teclea NO son letras', () => {
    // Un paréntesis o una barra no convierten el número en texto: si los dígitos están, esto
    // ni siquiera llega a hablar.
    for (const bueno of ['+34 600-11-22-33', '(600) 112233', '600.11.22.33', '+380/67/1234567']) {
        assert.strictEqual(N.problemaTelefono(bueno), null, bueno);
    }
});

test('decir QUÉ pasa no cambia QUIÉN puede reservar', () => {
    // La decisión que sostiene el bloque de arriba: `telefonoUsable` sigue siendo permisivo
    // —lo dice su propio comentario— y `problemaTelefono` solo elige el mensaje de quien ya
    // estaba parado. Meter las letras en el VEREDICTO dejaría fuera a esta señora, que hoy
    // reserva y cuya cita se guarda bien (el servidor sanea el teléfono).
    assert.ok(N.telefonoUsable('600112233 (casa)'), 'se ha endurecido el veredicto sin querer');
    assert.strictEqual(N.problemaTelefono('600112233 (casa)'), null);
    // Y al revés: todo lo que el veredicto rechaza tiene un motivo, nunca null.
    for (const malo of ['', '60011', 'mi movil', '1234567890123456789']) {
        assert.strictEqual(N.telefonoUsable(malo), false, malo);
        assert.notStrictEqual(N.problemaTelefono(malo), null, `${malo}: rechazado y sin explicación`);
    }
});

test('los tres problemas del teléfono se distinguen en los cuatro idiomas', () => {
    for (const lang of N.IDIOMAS) {
        const tabla = N.textos(lang).telefonoProblema;
        const dichos = new Set(Object.values(tabla));
        assert.strictEqual(dichos.size, 3,
            `${lang}: dos problemas distintos con el mismo texto — es el bug otra vez, traducido`);
    }
});

// ─── 7 bis · UN nombre de servicio, el mismo todo el recorrido ───────────────────────────
//
// «Cortes · Mujer y secado» en el resumen y «Corte mujer y secado» en la confirmación. El
// primero se componía AQUÍ, en el navegador, y no existía en ninguna otra parte del sistema:
// ni en `appointments.service`, ni en el recordatorio, ni en la agenda que mira el salón.

const CAT_SERVIDOR = [
    { key: 'Cortes|Mujer y secado', categoria: 'Cortes', nombre: 'Mujer y secado',
      nombreCompleto: 'Corte mujer y secado', precio: 40, duracion: 60 },
    { key: 'Cortes|Hombre', categoria: 'Cortes', nombre: 'Hombre',
      nombreCompleto: 'Corte hombre', precio: 25, duracion: 30 },
    { key: 'Brillo Glow|Brillo intensivo', categoria: 'Brillo Glow', nombre: 'Brillo intensivo',
      nombreCompleto: 'Brillo intensivo', precio: 30, duracion: 30 },
];

test('la entrada lleva el nombre del servidor, y la pantalla no compone ninguno', () => {
    const { grupos } = N.agruparCatalogo(CAT_SERVIDOR);
    const cortes = grupos.find(g => g.categoria === 'Cortes');
    assert.deepStrictEqual(cortes.entradas.map(e => e.nombreCompleto),
        ['Corte mujer y secado', 'Corte hombre']);
    // Lo que NO puede volver a salir de aquí, en ninguna forma.
    for (const e of cortes.entradas) {
        assert.ok(!e.nombreCompleto.includes(' · '),
            'la pantalla ha vuelto a pegar categoría y nombre con un separador');
    }
});

test('sin `nombreCompleto` se cae al `nombre` pelado, NUNCA a categoría + nombre', () => {
    // Un Express viejo sin desplegar. El respaldo tiene que ser un valor REAL del catálogo:
    // «Mujer y secado» es menos completo pero lo escribió la dueña; «Cortes · Mujer y
    // secado» no lo escribió nadie (regla 3).
    const { grupos } = N.agruparCatalogo([
        { key: 'Cortes|Mujer y secado', categoria: 'Cortes', nombre: 'Mujer y secado', precio: 40 },
    ]);
    assert.strictEqual(grupos[0].entradas[0].nombreCompleto, 'Mujer y secado');
    assert.ok(!grupos[0].entradas[0].nombreCompleto.includes('·'));
});

test('el título del paso 1: categoría si hay varias, EL SERVICIO si hay una', () => {
    // Cuatro de los seis grupos de una sola entrada del catálogo real tenían esta
    // divergencia: la fila decía «Brillo Glow» y la confirmación «Brillo intensivo».
    const { grupos } = N.agruparCatalogo(CAT_SERVIDOR);
    const porCat = Object.fromEntries(grupos.map(g => [g.categoria, g.titulo]));
    assert.strictEqual(porCat['Cortes'], 'Cortes', 'con varias opciones el título es la navegación');
    assert.strictEqual(porCat['Brillo Glow'], 'Brillo intensivo',
        'con una sola entrada, esa fila ES el servicio y tiene que llamarse como se llamará después');
});

test('el nombre del grupo de una entrada es EXACTAMENTE el de su entrada', () => {
    // Es lo que hace que el recorrido entero diga lo mismo: título del paso 1 → resumen →
    // confirmación son la misma cadena, no tres parecidas.
    const { grupos } = N.agruparCatalogo(CAT_SERVIDOR);
    for (const g of grupos) {
        if (g.entradas.length !== 1) continue;
        assert.strictEqual(g.titulo, g.entradas[0].nombreCompleto);
    }
});

// ─── 7 ter · El atrás y la recarga ───────────────────────────────────────────────────────
//
// El bug: recargar o dar al ATRÁS a mitad del formulario devolvía al paso 1 con todo perdido
// y sin decir nada. En un móvil el atrás es lo primero que se toca para corregir.
//
// Las dos mitades viven en sitios distintos y por motivos distintos: el ATRÁS en la pila del
// historial (una entrada por paso, SIEMPRE la misma URL) y la RECARGA en `sessionStorage`.
// Lo que se recupera NO se cree: se vuelve a preguntar al motor.

test('la secuencia depende de si la categoría tiene variantes, y es UNA', () => {
    // De esta lista salen a la vez el «paso 3 de 4» de la cabecera y la profundidad de la
    // pila. Con dos listas, el contador y el atrás contarían pasos distintos.
    assert.deepStrictEqual(N.secuenciaDe({ entradas: [1] }), ['servicio', 'dia', 'hora', 'datos']);
    assert.deepStrictEqual(N.secuenciaDe({ entradas: [1, 2] }),
        ['servicio', 'variante', 'dia', 'hora', 'datos']);
    assert.deepStrictEqual(N.secuenciaDe(null), ['servicio', 'dia', 'hora', 'datos']);
});

test('una entrada del historial que no es nuestra se deja en paz', () => {
    // Es lo que hace que el atrás desde el paso 1 SALGA de la página en vez de quedarse
    // dando vueltas dentro: esa entrada es de lo que la clienta estuviera viendo antes.
    assert.strictEqual(N.pasoDelHistorial({ reservaPaso: 'hora' }), 'hora');
    assert.strictEqual(N.pasoDelHistorial(null), null);
    assert.strictEqual(N.pasoDelHistorial({ otraCosa: 1 }), null);
    assert.strictEqual(N.pasoDelHistorial({ reservaPaso: 'inventado' }), null);
});

test('el ADELANTE del navegador no puede dejar la pantalla en blanco', () => {
    // Volver al día borra la hora; darle entonces a adelante pedía «tus datos» sin hora, y
    // ese paso no se pinta. Se recorta al último que de verdad tiene datos.
    const grupo = { entradas: [1, 2] };
    const con = (x) => ({ grupo, entrada: {}, fecha: '2026-11-04', hora: null, ...x });
    assert.strictEqual(N.pasoAlcanzable('datos', con({})), 'hora');
    assert.strictEqual(N.pasoAlcanzable('datos', con({ hora: '10:00' })), 'datos');
    assert.strictEqual(N.pasoAlcanzable('hora', con({ fecha: null })), 'dia');
    // Sin variante elegida se para en el paso de la variante, no en el 1: la categoría SÍ
    // la eligió, y devolverla al principio le borraría una decisión que sigue siendo suya.
    assert.strictEqual(N.pasoAlcanzable('dia', con({ entrada: null, fecha: null })), 'variante');
    assert.strictEqual(
        N.pasoAlcanzable('dia', { grupo: null, entrada: null, fecha: null, hora: null }), 'servicio');
    // El paso de la variante puede no existir en esta reserva: entonces no se para ahí.
    assert.strictEqual(
        N.pasoAlcanzable('variante', { grupo: { entradas: [1] }, entrada: {}, fecha: null, hora: null }),
        'servicio');
});

test('retroceder olvida lo mismo con el botón de la cabecera que con el del móvil', () => {
    // Hay DOS formas de retroceder y una sola tabla de qué se olvida. Con dos copias se
    // separan al primer retoque —una dejaría la hora puesta y la otra no— y eso no se ve
    // leyendo: hay que retroceder con las dos y comparar.
    assert.deepStrictEqual(N.limpiarAlVolver('dia').hora, true);
    assert.deepStrictEqual(N.limpiarAlVolver('dia').fecha, false);
    assert.deepStrictEqual(N.limpiarAlVolver('servicio'),
        { grupo: true, entrada: true, fecha: true, hora: true, listas: true });
    assert.deepStrictEqual(N.limpiarAlVolver('hora'),
        { grupo: false, entrada: false, fecha: false, hora: false, listas: false });
});

// ── Lo guardado ──

const AHORA = 1_800_000_000_000;
const PROG = {
    paso: 'datos', servicio: 'Cortes|Mujer y secado', fecha: '2026-11-04', hora: '10:00',
    nombre: 'Ana', telefono: '600111222',
};
const leerP = (bruto, extra = {}) =>
    N.leerProgreso(bruto, { hoy: '2026-08-21', ahora: AHORA, ...extra });

test('lo guardado va y vuelve entero', () => {
    assert.deepStrictEqual(leerP(N.serializarProgreso(PROG, AHORA)), PROG);
});

test('lo que no reconozcamos NO se restaura: se empieza limpio', () => {
    assert.strictEqual(leerP('{no es json'), null);
    assert.strictEqual(leerP(''), null);
    assert.strictEqual(leerP(null), null);
    assert.strictEqual(leerP('[]'), null, 'un array no es un progreso');
    assert.strictEqual(leerP(JSON.stringify({ v: 99, ts: AHORA, ...PROG })), null,
        'otra versión del formato: la de un deploy viejo no se interpreta a ojo');
    assert.strictEqual(leerP(JSON.stringify({ v: 1, ...PROG })), null, 'sin ts no se sabe si caducó');
    assert.strictEqual(leerP(N.serializarProgreso(PROG, AHORA - N.VIDA_PROGRESO_MS - 1)), null,
        'caducado: ahí dentro hay un nombre y un teléfono');
});

test('un paso malo DEGRADA, no tira los otros cuatro', () => {
    // Es el bug entero en un bloque: perder cuatro pasos por uno solo malo.
    const conFechaPasada = leerP(N.serializarProgreso({ ...PROG, fecha: '2020-01-01' }, AHORA));
    assert.strictEqual(conFechaPasada.paso, 'dia', 'una fecha que ya pasó devuelve al calendario');
    assert.strictEqual(conFechaPasada.fecha, null);
    assert.strictEqual(conFechaPasada.hora, null);
    assert.strictEqual(conFechaPasada.servicio, 'Cortes|Mujer y secado', 'el servicio no se pierde');
    assert.strictEqual(conFechaPasada.nombre, 'Ana', 'lo que tecleó tampoco');
    assert.strictEqual(conFechaPasada.telefono, '600111222');

    const sinHora = leerP(N.serializarProgreso({ ...PROG, hora: null }, AHORA));
    assert.strictEqual(sinHora.paso, 'hora', '«tus datos» sin hora no se puede pintar');

    const horaBasura = leerP(N.serializarProgreso({ ...PROG, hora: '25:99' }, AHORA));
    assert.strictEqual(horaBasura.hora, null);
    assert.strictEqual(horaBasura.paso, 'hora');
});

test('la cita ya hecha se guarda aparte y sobrevive a una recarga', () => {
    const cita = { fecha: '2026-11-04', hora: '10:00', cuando: 'el miércoles 4 de noviembre',
                   servicio: 'Corte mujer y secado', estilista: 'Irina' };
    const vuelta = leerP(N.serializarProgreso({ paso: 'hecha', cita }, AHORA));
    assert.deepStrictEqual(vuelta, { paso: 'hecha', cita });
    // Sin fecha y hora no es un acuse de nada: no se pinta media confirmación.
    assert.strictEqual(leerP(N.serializarProgreso({ paso: 'hecha', cita: { fecha: '2026-11-04' } }, AHORA)), null);
});

// ── De lo guardado a la pantalla ──

const GRUPOS = N.agruparCatalogo([
    { key: 'Cortes|Mujer y secado', categoria: 'Cortes', nombre: 'Mujer y secado',
      nombreCompleto: 'Corte mujer y secado', precio: 40, duracion: 60 },
    { key: 'Cortes|Hombre', categoria: 'Cortes', nombre: 'Hombre',
      nombreCompleto: 'Corte hombre', precio: 25, duracion: 30 },
    { key: 'Brillo Glow|Brillo intensivo', categoria: 'Brillo Glow', nombre: 'Brillo intensivo',
      nombreCompleto: 'Brillo intensivo', precio: 30, duracion: 30 },
]).grupos;

test('vuelve al paso donde estaba, y con el hueco por verificar', () => {
    const plan = N.restaurar(PROG, { grupos: GRUPOS });
    assert.strictEqual(plan.paso, 'datos');
    assert.strictEqual(plan.entrada.key, 'Cortes|Mujer y secado');
    assert.strictEqual(plan.grupo.categoria, 'Cortes');
    assert.strictEqual(plan.hora, '10:00');
    assert.strictEqual(plan.verificar, 'huecos',
        'volver a «tus datos» sin releer la agenda es mandarla a confirmar a ciegas');
});

test('un servicio dado de baja entremedias no se lleva por delante lo demás', () => {
    const plan = N.restaurar({ ...PROG, servicio: 'Cortes|Ya no existe' }, { grupos: GRUPOS });
    assert.strictEqual(plan.paso, 'servicio');
    assert.strictEqual(plan.entrada, null);
    assert.strictEqual(plan.verificar, null, 'no hay nada que releer si no hay servicio');
    assert.strictEqual(plan.nombre, 'Ana', 'el nombre no caduca porque cambie el catálogo');
    assert.strictEqual(plan.telefono, '600111222');
});

test('el paso de la variante puede haber dejado de existir', () => {
    // La dueña dio de baja las otras opciones de esa categoría. Sin esto, la pantalla pediría
    // elegir entre una sola cosa.
    const plan = N.restaurar(
        { paso: 'variante', servicio: 'Brillo Glow|Brillo intensivo', fecha: null, hora: null,
          nombre: '', telefono: '' },
        { grupos: GRUPOS });
    assert.strictEqual(plan.paso, 'dia');
});

// ── El hueco recuperado, que es lo que no se puede dar por bueno ──

test('si el hueco ya no está se DICE, y se vuelve a la lista de horas', () => {
    const v = N.trasVerificarHuecos(
        { paso: 'datos', hora: '10:00' },
        { leida: true, horas: ['11:00', '12:00'] });
    assert.strictEqual(v.paso, 'hora');
    assert.strictEqual(v.hora, null, 'reservar con la hora vieja sería reservar a ciegas');
    assert.strictEqual(v.aviso, 'hueco_caducado');
});

test('si el día entero se quedó sin nada, al calendario', () => {
    const v = N.trasVerificarHuecos({ paso: 'datos', hora: '10:00' }, { leida: true, horas: [] });
    assert.strictEqual(v.paso, 'dia');
    assert.strictEqual(v.aviso, 'hueco_caducado');
});

test('si el hueco SIGUE libre no se la mueve ni se le dice nada', () => {
    const v = N.trasVerificarHuecos(
        { paso: 'datos', hora: '10:00' },
        { leida: true, horas: ['10:00', '11:00'] });
    assert.deepStrictEqual(v, { paso: 'datos', hora: '10:00', aviso: null });
});

test('una lectura ROTA no es un día vacío: no se le dice que su hora se ha ocupado', () => {
    // Hecho 2 de CLAUDE.md metido en una pantalla. Sin el `leida`, un fallo de red al volver
    // le contaría que le han quitado el hueco —y la sacaría de donde estaba— por algo que
    // nadie ha llegado a preguntar.
    const v = N.trasVerificarHuecos({ paso: 'datos', hora: '10:00' }, { leida: false, horas: [] });
    assert.deepStrictEqual(v, { paso: 'datos', hora: '10:00', aviso: null });
});

test('el aviso del hueco caducado NO saca un botón de WhatsApp', () => {
    // Es la misma decisión que `enlaceDelAviso` explica para «ese hueco se acaba de ocupar»:
    // lo que esa clienta tiene que hacer es tocar otra hora, que la tiene delante.
    const fallo = N.avisoPropio('hueco_caducado');
    assert.strictEqual(N.enlaceDelAviso(fallo, 'https://wa.me/34641029104?text=hola'), null);
    assert.strictEqual(N.vueltaDe('hueco_caducado'), 'huecos');
    for (const lang of N.IDIOMAS) {
        const txt = N.textoDelAviso(N.textos(lang), fallo);
        assert.ok(txt.titulo && txt.cuerpo, `${lang}: el aviso saldría mudo`);
    }
});

// ─── 8 · Lo que solo se puede mirar leyendo el fichero ───────────────────────────────────
//
// Estas tres no se pueden EJECUTAR desde aquí (son React y el `proxy` de Next), pero lo que
// vigilan no es redacción: es que la página pública siga siendo pública. Molde de
// tests/etiquetas-escalada-paridad.test.js, que lee el TSX del panel por el mismo motivo.

const fs = require('fs');
const APP = path.join(__dirname, '..', 'dashboard-app', 'src');
const leer = (...t) => fs.readFileSync(path.join(APP, ...t), 'utf8');

test('el proxy exime la ruta pública ANTES de hablar con Supabase', () => {
    // Crear el cliente y pedir `auth.getUser()` es un viaje a Supabase. Hacerlo antes de la
    // exención lo metía en CADA petición de la página pública —el HTML y las cuatro del
    // formulario— y ataba la única pantalla sin sesión del sistema a que el login esté vivo.
    const src = leer('proxy.ts');
    const exencion = src.indexOf('esRutaPublicaDeReserva(pathname)');
    const cliente = src.indexOf('createClient(request)');
    assert.ok(exencion > 0 && cliente > 0, 'el proxy ha cambiado de forma: revisa este test');
    assert.ok(exencion < cliente,
        'la página pública vuelve a preguntar por una sesión que por definición no existe');
});

test('la pantalla pública no arrastra NADA del panel con sesión', () => {
    // Un componente del panel dentro de esta página la rompe para quien no tenga cuenta:
    // `OrgProvider` y `lib/api` mandan el header de organización y el JWT, y el cliente de
    // Supabase redirige a /login. Se cae en cuanto alguien reutilice una pieza «que ya
    // existe» sin darse cuenta de que esa pieza da por hecha una sesión.
    const prohibidos = ['@/lib/org-context', '@/lib/api', '@/utils/supabase', '@/lib/bot-status-context'];
    const ficheros = [
        ['app', 'reservar', '[slug]', 'page.tsx'],
        ['app', 'reservar', '[slug]', 'error.tsx'],
        ['components', 'reservar', 'formulario-reserva.tsx'],
        ['components', 'reservar', 'piezas.tsx'],
        ['lib', 'reservar', 'nucleo.ts'],
    ];
    for (const f of ficheros) {
        const src = leer(...f);
        for (const mal of prohibidos) {
            assert.ok(!src.includes(mal), `${f.join('/')} importa ${mal}: la página deja de ser pública`);
        }
    }
});

test('la pantalla de avería NO se queda clavada en castellano', () => {
    // `error.tsx` lo monta React cuando el árbol ya se ha caído y no le llegan props. Si
    // resolviera «es» a pelo, una clienta rusa vería la única pantalla que no puede evitar
    // —la de avería— en un idioma que no lee, y justo en el peor momento.
    const src = leer('app', 'reservar', '[slug]', 'error.tsx');
    assert.ok(src.includes('elegirIdioma'),
        'error.tsx no recupera el idioma: revisa que no haya vuelto a un textos("es")');
    assert.ok(!/textos\("es"\)/.test(src), 'error.tsx tiene el castellano cableado');
});

test('el PASO no va en la URL: un enlace copiado a mitad no lleva reserva dentro', () => {
    // La decisión del 21/08: el atrás vive en la pila del historial y la recarga en
    // `sessionStorage`, y la dirección no cambia en ningún paso. Meter el paso en la URL
    // habría salido gratis, pero entonces reenviar el enlace es mandar tu reserva a medias, y
    // la dirección cuenta por WhatsApp qué te ibas a hacer.
    //
    // `pushState`/`replaceState` con TERCER argumento son los que tocan la dirección. Solo
    // hay uno permitido, y es el del selector de idioma — que reescribe `?lang=` porque el
    // idioma SÍ tiene que sobrevivir a compartir el enlace.
    const src = leer('components', 'reservar', 'formulario-reserva.tsx');
    const conUrl = [...src.matchAll(/history\.(?:push|replace)State\(([^;]*?)\);/g)]
        .map(m => m[1].replace(/\s+/g, ' ').trim())
        .filter(args => args.split(',').length > 2);
    assert.deepStrictEqual(conUrl, ['window.history.state, "", url.toString()'],
        `alguien ha metido el paso en la dirección: ${conUrl.join(' | ')}`);
});

test('el progreso se guarda en la pestaña, no en el disco', () => {
    // `localStorage` sobreviviría al cierre del navegador con un nombre y un teléfono dentro,
    // en un móvil que puede ser de casa. `sessionStorage` muere con la pestaña.
    const src = leer('components', 'reservar', 'formulario-reserva.tsx');
    // Se busca el USO (`localStorage.algo`) y no la palabra: el comentario que explica por
    // qué no se usa la nombra, y un test que se cayera con su propia explicación al lado es
    // de los que se borran en vez de arreglarse.
    assert.ok(!/localStorage\s*\./.test(src), 'el nombre y el teléfono sobrevivirían al navegador');
    assert.ok(/sessionStorage\s*\./.test(src));
});

test('el núcleo de la pantalla no importa nada: es lo que lo hace ejecutable aquí', () => {
    // Un `import` de otro módulo del panel —o un alias `@/`— lo vuelve inejecutable fuera de
    // Next, y entonces los 30 bloques de arriba dejan de existir.
    const src = leer('lib', 'reservar', 'nucleo.ts');
    const imports = src.match(/^\s*import[\s{]/gm) || [];
    assert.deepStrictEqual(imports, [],
        'nucleo.ts ha ganado un import: este fichero de test deja de poder cargarlo');
});

process.exit(fallos ? 1 : 0);
