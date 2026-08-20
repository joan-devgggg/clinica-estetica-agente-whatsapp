/**
 * tests/reserva-web-endpoints.test.js — Las cuatro rutas públicas, y sobre todo sus NOES.
 *
 * Es la primera superficie del proyecto SIN SESIÓN: hasta ahora todo lo que no era el webhook
 * de 360dialog colgaba de un JWT, así que un error de autorización no tenía dónde hacer daño.
 * Por eso aquí hay más bloques de camino BLOQUEADO que de camino feliz — el camino feliz lo
 * prueba cualquiera; lo que hay que fijar es a quién se le dice que no, cómo, y qué no se
 * cuenta al decírselo.
 *
 * Se ejercita el Express REAL con `node:http` (patrón de api-auth-isolation.test.js), con la
 * capa de datos y el motor de huecos mockeados. Nada toca Supabase ni la red.
 *
 * ── Sabotajes medidos (20/08/2026) ───────────────────────────────────────────────────────
 * Los 18 se corrieron contra los tres ficheros de este grupo; aquí van los que caza ÉSTE.
 *
 *   · quitar el guard del secreto ................................................ 2 rojos
 *   · `resolveOrgBySlug` sin el gate de tipo (entra San Remo) .................... 2 rojos
 *   · catálogo con `offerableCatalog` en vez de `botOfferableCatalog` ............ 1 rojo
 *   · no filtrar `isReactiveOnlyService` (la Consulta entra) ..................... 1 rojo
 *   · el 404 del slug devolviendo lo que se pidió ................................ 1 rojo
 *   · resolver el servicio contra el catálogo COMPLETO ........................... 2 rojos
 *   · `saveLead` pisando el nombre guardado ...................................... 1 rojo
 *   · la lista negra escribiendo la cita igual ................................... 1 rojo
 *   · el tope de citas mandando recargar huecos .................................. 5 rojos
 *   · el cupo de LECTURAS bajado al de reservas (3/h) ............................ 1 rojo
 *   · un tope de 0 leído como «sin configurar» ................................... 1 rojo
 *
 * Añadidos el 20/08 con lo que la PANTALLA necesita (nombre del salón y el «cuándo»):
 *   · `salonPublico` esparciendo `business_info` .................................. 1 rojo
 *     (y 2 más en reserva-web-sin-fugas, que es donde vive el veneno)
 *   · inventar el nombre del salón cuando falta `companyName` ..................... 1 rojo
 *   · formatear el «cuándo» con `toLocaleDateString` en vez de `formatReminderWhen`  3 rojos
 *     — y el rojo se lee solo: «10:00 четверг, 10 сентября», nominativo, que es
 *     literalmente el motivo por el que esa tabla existe.
 *
 * Y con el CANDADO del doble envío (20/08, seis bloques nuevos):
 *   · el candado sin efecto (llamar al trabajo y ya) ............................. 3 rojos
 *   · sin la memoria de éxitos (solo coalescencia en vuelo) ...................... 3 rojos
 *   · sin la coalescencia en vuelo (solo memoria) ................................ 1 rojo
 *     — y es justo el bloque del solape real, que es la única forma de saber que las dos
 *     mitades hacen cosas distintas: la memoria tapa el reenvío tardío, la coalescencia
 *     tapa las dos peticiones que se pisan.
 *   · meter algo variable en la clave (equivale a no tener clave) ................ 3 rojos
 *   · guardar también los NOES ................................................... 1 rojo
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RESERVA_WEB_TOKEN = 'token-de-prueba-32-caracteres-xx';

const assert = require('assert');
const http = require('http');

// Telegram fuera antes de cargar webhook: no cargar el bot ni tocar red.
const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyReservaWeb: async () => {}, notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const db = require('../services/db');
const calendarSante = require('../services/calendar-sante');
const { app, _limitadorReservas, _candadoReserva } = require('../webhook');

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SLUG = 'sante-healthy-hair-salon';
const SLUG_SANREMO = 'restaurante-san-remo';
const TOKEN = process.env.RESERVA_WEB_TOKEN;
const SERVICIO_Q = encodeURIComponent('Cortes|Corte mujer');

const IRINA = 'c3d4e5f6-0000-0000-0000-000000000101';
const NATALIA = 'c3d4e5f6-0000-0000-0000-000000000107';

// ─── El catálogo de prueba: uno de cada cosa que tiene que quedarse fuera ────────────────
const CATALOGO = [
    { categoria: 'Cortes', nombre: 'Corte mujer', precio: 35, duracion: 60 },
    // La entrada del incidente del 21/08, con sus cadenas REALES: el catálogo la guarda como
    // «Mujer y secado» dentro de la categoría «Cortes», y `buildFullServiceName` la nombra
    // «Corte mujer y secado». Es el único par de este catálogo en el que el nombre del
    // servicio NO coincide con su `nombre` pelado, o sea el único que puede cazar que la
    // pantalla y la cita se llamen distinto.
    { categoria: 'Cortes', nombre: 'Mujer y secado', precio: 40, duracion: 60 },
    { categoria: 'Color', nombre: 'Mechas Balayage', precio: 180, duracion: 240 },
    // Los tres que NO pueden salir a una página pública, cada uno por su motivo:
    { categoria: 'Peinados', nombre: 'Peinado con tratamientos', precio: 15, duracion: 15, solo_complemento: true },
    { categoria: 'Color', nombre: 'Tinte retirado', precio: 50, duracion: 90, activo: false },
    { categoria: 'Consulta', nombre: 'Consulta de valoración', precio: null, duracion: 20 },
];

let ESTADO;
function reset() {
    // El limitador es un singleton del proceso (es lo que lo hace real en producción), así
    // que sin esto cada bloque heredaría lo gastado por el anterior y el techo por org
    // saldría agotado antes de empezar a probarlo.
    _limitadorReservas._reset();
    // El candado del doble envío también es un singleton del proceso: sin esto, el segundo
    // bloque que reserve el MISMO hueco con el MISMO teléfono recibe la respuesta guardada
    // del primero y no llega a ejecutarse. Es la conducta buena, y por eso hay que limpiarla
    // entre bloques igual que la del limitador.
    _candadoReserva._reset();
    ESTADO = {
        config: {
            reservas_web_activo: true,
            reservas_web_max_hora_ip: 3,
            reservas_web_max_hora_org: 10,
            reservas_web_max_futuras: 2,
            reservas_web_max_hora_lecturas_ip: 120,
        },
        // `business_info` lo edita la dueña y lleva dentro cosas que no salen a internet.
        businessInfo: {
            companyName: 'Sante Healthy Hair Salon',
            direccion: 'Calle San Juan Bosco 14, Alicante 03005',
            notas_internas: 'no publicar',
        },
        retrasoMs: 0,             // para forzar solape real en el candado
        contacto: null,           // lo que devuelve getContactoParaReservaWeb
        leadGuardado: null,       // lo que recibió saveLead
        citas: [],                // lo que recibió saveAppointment
        rechazos: [],             // motivos a lanzar, en orden, uno por intento
        // Cuatro horas y no una: desde que existe el candado del doble envío, repetir la
        // MISMA reserva no es una reserva nueva, así que los bloques del limitador tienen
        // que pedir huecos DISTINTOS o estarían midiendo el candado sin saberlo.
        slots: ['10:00', '11:00', '12:00', '13:00'].map(hora => ({
            fecha: '2026-09-10', hora, diaNombre: 'jueves', stylistId: IRINA, stylistName: 'Irina',
            alternativas: [{ id: IRINA, name: 'Irina' }, { id: NATALIA, name: 'Natalia' }],
        })),
        dias: [{ fecha: '2026-09-10', diaSemana: 3, huecos: 4,
                 estilistas: [{ id: IRINA, name: 'Irina' }, { id: NATALIA, name: 'Natalia' }] }],
    };
}

db.getAllConfig = async () => ESTADO.config;
db.getAgentConfig = async () => ({ services: CATALOGO, business_info: ESTADO.businessInfo });
db.getContactoParaReservaWeb = async () => ESTADO.contacto;
db.saveLead = async (_org, datos) => { ESTADO.leadGuardado = datos; return 'contact-1'; };
db.saveAppointment = async (_org, contactId, opts) => {
    // Con retraso, dos peticiones se solapan DE VERDAD y se prueba la coalescencia en vuelo,
    // que es otra cosa que la memoria de éxitos: con los dobles instantáneos de este fichero
    // la segunda llega cuando la primera ya terminó, y entonces quien salva es la memoria.
    if (ESTADO.retrasoMs) await new Promise(r => setTimeout(r, ESTADO.retrasoMs));
    ESTADO.citas.push({ contactId, ...opts });
    const motivo = ESTADO.rechazos.shift();
    if (motivo) throw new db.ReservaWebRechazada(motivo);
    return { id: `cita-${ESTADO.citas.length}`, starts_at: '2026-09-10T10:00:00+02:00' };
};
calendarSante.getAvailableSlots = async () => {
    const out = [...ESTADO.slots];
    out.causa = null; out.requestedDayUnavailable = false; out.weekPreferenceRelaxed = false;
    return out;
};
calendarSante.getAvailableDays = async () => {
    const out = [...ESTADO.dias];
    out.causa = null;
    return out;
};

function request(server, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
    const { port } = server.address();
    const datos = body === null ? null : JSON.stringify(body);
    const cabeceras = { ...headers };
    if (datos) { cabeceras['Content-Type'] = 'application/json'; cabeceras['Content-Length'] = Buffer.byteLength(datos); }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: cabeceras }, (res) => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null, raw: d }));
        });
        req.on('error', reject);
        if (datos) req.write(datos);
        req.end();
    });
}

// Cabeceras de una petición que viene del Next: el secreto y la IP de la clienta.
const desde = (ip) => ({ 'X-Reserva-Token': TOKEN, 'X-Cliente-IP': ip });

const CUERPO_RESERVA = {
    servicio: 'Cortes|Corte mujer',
    fecha: '2026-09-10', hora: '10:00',
    // El país va SEPARADO del número, que es como lo manda la pantalla desde el 22/08/2026.
    // El porqué —y qué pasaba cuando iban juntos— en tests/reserva-web-telefono.test.js.
    nombre: 'Marta', prefijo: '34', telefono: '600111222', lang: 'es',
};

async function test(name, fn) {
    try { reset(); await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    let n = 0;
    const ipNueva = () => `10.0.0.${++n}`;   // cada bloque con su IP: el limitador es real

    try {
        // ─── EL SECRETO ─────────────────────────────────────────────────────────────────
        await test('sin el secreto compartido → 404, en las CUATRO rutas', async () => {
            for (const [method, path] of [
                ['GET', `/reserva-web/${SLUG}/catalogo`],
                ['GET', `/reserva-web/${SLUG}/dias?servicio=${SERVICIO_Q}`],
                ['GET', `/reserva-web/${SLUG}/huecos?servicio=${SERVICIO_Q}&fecha=2026-09-10`],
                ['POST', `/reserva-web/${SLUG}/reserva`],
            ]) {
                const res = await request(server, { method, path, body: method === 'POST' ? CUERPO_RESERVA : null });
                assert.strictEqual(res.status, 404, `${method} ${path} contestó ${res.status} sin secreto`);
            }
        });

        await test('un secreto EQUIVOCADO da el mismo 404 que no mandar ninguno', async () => {
            const malo = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`,
                headers: { 'X-Reserva-Token': 'x'.repeat(TOKEN.length) },
            });
            const sin = await request(server, { path: `/reserva-web/${SLUG}/catalogo` });
            assert.strictEqual(malo.status, 404);
            assert.strictEqual(malo.raw, sin.raw, 'un token equivocado se distingue de uno ausente');
        });

        // ─── NO SE DICE QUÉ SALONES EXISTEN ─────────────────────────────────────────────
        await test('slug inexistente y SAN REMO dan la MISMA respuesta, byte por byte', async () => {
            const inventado = await request(server, {
                path: '/reserva-web/salon-que-no-existe/catalogo', headers: desde(ipNueva()),
            });
            const sanRemo = await request(server, {
                path: `/reserva-web/${SLUG_SANREMO}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(inventado.status, 404);
            assert.strictEqual(sanRemo.status, 404);
            assert.strictEqual(inventado.raw, sanRemo.raw,
                'se puede distinguir un salón que existe de uno que no: eso permite enumerarlos');
        });

        await test('SAN REMO: tampoco puede reservar, aunque le pongan el interruptor', async () => {
            ESTADO.config.reservas_web_activo = true;
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG_SANREMO}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(ESTADO.citas.length, 0, 'se ha intentado escribir una cita de San Remo');
        });

        // ─── EL INTERRUPTOR ─────────────────────────────────────────────────────────────
        await test('con el enlace apagado: 503, motivo claro y WhatsApp abierto', async () => {
            ESTADO.config.reservas_web_activo = false;
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(res.status, 503);
            assert.strictEqual(res.body.motivo, 'cerrado');
            assert.ok(res.body.whatsapp?.startsWith('https://wa.me/34641029104?text='));
        });

        await test('una config ILEGIBLE cierra el enlace, no lo abre con valores inventados', async () => {
            ESTADO.config = {};   // como si getAllConfig hubiera devuelto {} por un fallo
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(res.body.motivo, 'cerrado');
        });

        // ─── EL CATÁLOGO ────────────────────────────────────────────────────────────────
        await test('el catálogo público deja fuera complemento, inactivo y Consulta', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(res.status, 200);
            const nombres = res.body.servicios.map(s => s.nombre);
            assert.deepStrictEqual(nombres.sort(), ['Corte mujer', 'Mechas Balayage', 'Mujer y secado']);
            assert.ok(!nombres.includes('Peinado con tratamientos'), 'un solo_complemento se ofrece en la web');
            assert.ok(!nombres.includes('Tinte retirado'), 'un servicio de baja se ofrece en la web');
            assert.ok(!nombres.includes('Consulta de valoración'), 'la Consulta reactive-only se ofrece en la web');
        });

        await test('el catálogo lleva SOLO los campos que la página necesita', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            for (const s of res.body.servicios) {
                assert.deepStrictEqual(Object.keys(s).sort(),
                    ['categoria', 'duracion', 'key', 'nombre', 'nombreCompleto', 'precio']);
            }
        });

        // ─── EL NOMBRE DEL SERVICIO, que tiene que ser UNO ──────────────────────────────
        //
        // La pantalla enseñaba «Cortes · Mujer y secado» en el resumen y «Corte mujer y
        // secado» en la confirmación: dos nombres para lo mismo, y el primero no existe en
        // ningún sitio —se componía en el navegador—. Estos dos bloques atan los extremos.

        await test('el catálogo trae EL nombre, el de `buildFullServiceName`', async () => {
            const { buildFullServiceName } = require('../services/helpers');
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            const porNombre = Object.fromEntries(res.body.servicios.map(s => [s.nombre, s.nombreCompleto]));
            assert.strictEqual(porNombre['Mujer y secado'], 'Corte mujer y secado',
                'la página seguiría llamándolo de otra forma que la cita');
            // Y el resto, uno por uno, contra la función de verdad — no contra una lista
            // escrita a mano, que caducaría en el primer cambio del catálogo (regla 5).
            for (const s of res.body.servicios) {
                const entrada = CATALOGO.find(c => c.categoria === s.categoria && c.nombre === s.nombre);
                assert.strictEqual(s.nombreCompleto, buildFullServiceName(entrada, CATALOGO),
                    `${s.categoria}|${s.nombre}: la proyección no usa buildFullServiceName`);
            }
        });

        await test('el nombre del catálogo y el de la cita creada son la MISMA cadena', async () => {
            // El cruce entero, con las dos rutas reales: lo que la página pinta en el
            // resumen sale del catálogo, y lo que se escribe en `appointments.service` sale
            // de `resolverServicioPublico`. Si alguien toca una de las dos llamadas a
            // `buildFullServiceName` y no la otra, la clienta vuelve a leer dos nombres.
            const cat = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            const entrada = cat.body.servicios.find(s => s.nombre === 'Mujer y secado');
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()),
                body: { servicio: entrada.key, fecha: '2026-09-10', hora: '10:00',
                        nombre: 'Ana', telefono: '600111222' },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.cita.servicio, entrada.nombreCompleto,
                'el acuse llama a la cita de otra forma que el catálogo');
            assert.strictEqual(ESTADO.citas[0].servicio, entrada.nombreCompleto,
                'lo que se escribe en appointments.service no es lo que se enseñó');
            assert.strictEqual(entrada.nombreCompleto, 'Corte mujer y secado');
        });

        await test('el catálogo trae el NOMBRE del salón y una salida por WhatsApp', async () => {
            // Van en la PRIMERA llamada de la página a propósito: así la clienta tiene una
            // salida humana guardada antes de que pueda fallar nada más. Y el nombre sale de
            // `business_info`, que lo edita la dueña — nunca del slug ni de una constante del
            // panel, que sería una segunda copia (regla 5).
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(res.body.salon.nombre, 'Sante Healthy Hair Salon');
            assert.ok(res.body.salon.whatsapp.startsWith('https://wa.me/34641029104?text='));
            assert.deepStrictEqual(Object.keys(res.body.salon).sort(),
                ['direccion', 'nombre', 'puertas', 'whatsapp']);
            assert.ok(!res.raw.includes('no publicar'), 'business_info se ha esparcido entero');
        });

        await test('la DIRECCIÓN sale para la pantalla final, en una línea y acotada', async () => {
            ESTADO.businessInfo = {
                companyName: 'Sante',
                direccion: 'Calle San Juan Bosco 14\n  Alicante\t03005',
                notas_internas: 'no publicar',
            };
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(res.body.salon.direccion, 'Calle San Juan Bosco 14 Alicante 03005',
                'la dirección va a un <p>, pero entra saneada igual que las notas');
            // Y sin dirección escrita, null: no se inventa una (regla 3).
            ESTADO.businessInfo = { companyName: 'Sante' };
            const sin = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(sin.body.salon.direccion, null);
        });

        await test('LAS DOS PUERTAS: cada una con SU mensaje ya escrito', async () => {
            // No son motivos: nadie las devuelve al decir que no. Son las dos salidas que el
            // formulario NO sabe hacer —la Consulta es reactive-only y el motor no puede ver
            // dos estilistas libres a la vez— y sin ellas esos casos acaban en una reserva
            // mal hecha.
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            const { asesoramiento, varias_personas: dos } = res.body.salon.puertas;
            assert.ok(asesoramiento.startsWith('https://wa.me/34641029104?text='));
            assert.ok(dos.startsWith('https://wa.me/34641029104?text='));
            assert.notStrictEqual(asesoramiento, dos, 'las dos puertas mandan el MISMO mensaje');
            assert.ok(decodeURIComponent(asesoramiento).includes('asesor'));
            assert.ok(decodeURIComponent(dos).includes('dos personas'));
            // Y ninguna es el genérico de «no he podido», que sería mentira: no lo ha intentado.
            assert.notStrictEqual(asesoramiento, res.body.salon.whatsapp);
            assert.notStrictEqual(dos, res.body.salon.whatsapp);
        });

        await test('los nombres de los SERVICIOS no se traducen: el catálogo es el del salón', async () => {
            // La clienta lee «Mechas Balayage» aquí, en la puerta del salón, en la factura y
            // en el WhatsApp de la dueña. Traducirlo sería que no lo reconociera al llegar.
            // Lo que cambia con el idioma son los enlaces de WhatsApp, no el catálogo.
            const es = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo?lang=es`, headers: desde(ipNueva()),
            });
            const ru = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo?lang=ru`, headers: desde(ipNueva()),
            });
            assert.deepStrictEqual(ru.body.servicios, es.body.servicios,
                'el catálogo ha cambiado con el idioma');
            assert.notStrictEqual(ru.body.salon.whatsapp, es.body.salon.whatsapp,
                'los enlaces sí tienen que cambiar de idioma');
        });

        await test('las puertas van en los CUATRO idiomas, y en cuatro DISTINTOS', async () => {
            const vistos = new Set();
            for (const lang of ['es', 'en', 'ru', 'uk']) {
                const res = await request(server, {
                    path: `/reserva-web/${SLUG}/catalogo?lang=${lang}`, headers: desde(ipNueva()),
                });
                const texto = decodeURIComponent(res.body.salon.puertas.varias_personas);
                assert.ok(texto.length > 20, `${lang} sin texto de puerta`);
                vistos.add(texto);
            }
            assert.strictEqual(vistos.size, 4,
                'dos idiomas mandan el MISMO mensaje: alguno se quedó sin traducir');
        });

        await test('sin companyName el nombre es null: la página dirá la frase sin nombre', async () => {
            ESTADO.businessInfo = { notas_internas: 'no publicar' };
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(res.body.salon.nombre, null,
                'un nombre inventado en la confirmación de una reserva es lo peor que puede salir de aquí');
            assert.ok(res.body.salon.whatsapp, 'la salida por WhatsApp no depende del nombre');
        });

        await test('un catálogo que no se puede LEER no sale como catálogo vacío', async () => {
            const orig = db.getAgentConfig;
            db.getAgentConfig = async () => null;   // lo que devuelve cuando la lectura falla
            try {
                const res = await request(server, {
                    path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
                });
                assert.strictEqual(res.status, 500);
                assert.strictEqual(res.body.motivo, 'error_interno');
                assert.ok(!Array.isArray(res.body.servicios), 'un salón sin catálogo legible se ha enseñado como salón sin servicios');
            } finally { db.getAgentConfig = orig; }
        });

        // ─── DÍAS Y HUECOS ──────────────────────────────────────────────────────────────
        await test('los días llevan fecha, cuántos huecos y quién — y nada más', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/dias?servicio=${encodeURIComponent('Cortes|Corte mujer')}`,
                headers: desde(ipNueva()),
            });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(Object.keys(res.body.dias[0]).sort(), ['estilistas', 'fecha', 'huecos']);
            assert.deepStrictEqual(Object.keys(res.body.dias[0].estilistas[0]).sort(), ['id', 'nombre']);
        });

        await test('los huecos NO llevan el `texto` que el motor fabrica para el modelo', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/huecos?servicio=${encodeURIComponent('Cortes|Corte mujer')}&fecha=2026-09-10`,
                headers: desde(ipNueva()),
            });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(Object.keys(res.body.huecos[0]).sort(), ['estilistas', 'fecha', 'hora']);
            assert.ok(!('texto' in res.body.huecos[0]));
            assert.ok(!('stylistId' in res.body.huecos[0]), 'se ha colado el nombre interno del campo');
        });

        await test('una fecha con formato de fantasía no llega al motor', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/huecos?servicio=${encodeURIComponent('Cortes|Corte mujer')}&fecha=ayer`,
                headers: desde(ipNueva()),
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.motivo, 'datos_invalidos');
        });

        await test('pedir huecos de un servicio SOLO_COMPLEMENTO no devuelve nada reservable', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/huecos?servicio=${encodeURIComponent('Peinados|Peinado con tratamientos')}&fecha=2026-09-10`,
                headers: desde(ipNueva()),
            });
            assert.strictEqual(res.body.motivo, 'servicio_no_disponible');
        });

        // ─── LA RESERVA ─────────────────────────────────────────────────────────────────
        await test('reserva buena: se escribe con source web y se confirma lo que ella eligió', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.ok, true);
            assert.strictEqual(res.body.cita.fecha, '2026-09-10');
            assert.strictEqual(res.body.cita.hora, '10:00');
            assert.strictEqual(res.body.cita.estilista, 'Irina');
            assert.strictEqual(ESTADO.citas.length, 1);
            assert.strictEqual(ESTADO.citas[0].source, 'web');
            assert.strictEqual(ESTADO.citas[0].stylistId, IRINA);
            // El tope de la dueña viaja hasta el SQL, que es quien lo aplica de verdad.
            assert.strictEqual(ESTADO.citas[0].maxFuturas, 2);
            assert.strictEqual(ESTADO.leadGuardado.origen, 'web');
        });

        await test('la confirmación dice el CUÁNDO con el mismo formateador que el recordatorio', async () => {
            // Contención, molde de tests/slot-texto-idioma.test.js: no se comprueba una
            // cadena copiada aquí, se comprueba que sale de `formatReminderWhen`. Si alguien
            // le da a la pantalla una tabla de días propia, esto se cae — que es el punto:
            // el recordatorio de 24 h y la confirmación le dicen el día a la MISMA clienta.
            const { formatReminderWhen } = require('../services/helpers');
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.body.cita.cuando, formatReminderWhen('2026-09-10', '10:00', 'es'));
            assert.ok(res.body.cita.cuando.includes('jueves'));
        });

        await test('el CUÁNDO va en el idioma que pidió, con su acusativo', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: { ...CUERPO_RESERVA, lang: 'ru' },
            });
            // «в четверг», no «четверг»: es TODO el motivo de que la tabla exista.
            assert.ok(res.body.cita.cuando.includes('в четверг'),
                `el ruso ha salido en nominativo o en castellano: ${res.body.cita.cuando}`);
        });

        await test('una fecha que no se sabe formatear NO tumba una cita ya escrita', async () => {
            // `cuando` a null y la cita confirmada igual: la página enseña fecha y hora
            // sueltas. Es la regla 3 por el lado bueno — no se inventa, pero tampoco se
            // pierde una cita que ya está en la agenda por un problema de redacción.
            const orig = require('../services/helpers').formatReminderWhen;
            require('../services/helpers').formatReminderWhen = () => null;
            try {
                const res = await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                    headers: desde(ipNueva()), body: CUERPO_RESERVA,
                });
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.cita.cuando, null);
                assert.strictEqual(res.body.cita.fecha, '2026-09-10');
                assert.strictEqual(res.body.cita.hora, '10:00');
            } finally { require('../services/helpers').formatReminderWhen = orig; }
        });

        // ─── EL DOBLE ENVÍO ─────────────────────────────────────────────────────────────
        //
        // Sin el candado esto crea DOS CITAS, no una: la segunda pierde el claim contra la
        // estilista de la primera y el bucle reintenta con la SIGUIENTE del hueco, que está
        // libre. Misma clienta, misma hora, dos estilistas. Y el tope de citas futuras no lo
        // ve, porque la primera solo suma una.
        await test('dos POST IDÉNTICOS a la vez → UNA cita, y las dos respuestas iguales', async () => {
            // La primera pierde el claim con Irina para que el bucle quiera reintentar con
            // Natalia — que es exactamente el camino por el que salían dos citas.
            const ip = ipNueva();
            const [a, b] = await Promise.all([
                request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA }),
                request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA }),
            ]);
            assert.strictEqual(a.status, 200);
            assert.strictEqual(b.status, 200);
            assert.strictEqual(a.raw, b.raw, 'las dos respuestas tenían que ser la MISMA, byte por byte');
            assert.strictEqual(ESTADO.citas.length, 1,
                `el doble envío ha escrito ${ESTADO.citas.length} citas`);
        });

        await test('dos POST SOLAPADOS DE VERDAD: el trabajo corre UNA vez', async () => {
            // Con la escritura tardando 60 ms, la segunda petición entra mientras la primera
            // sigue dentro. Aquí no salva la memoria de éxitos —todavía no hay éxito que
            // recordar—: salva que mirar y escribir el Map de «en vuelo» no tiene ningún
            // `await` en medio.
            ESTADO.retrasoMs = 60;
            const ip = ipNueva();
            const [a, b] = await Promise.all([
                request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA }),
                request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA }),
            ]);
            assert.strictEqual(a.status, 200);
            assert.strictEqual(b.raw, a.raw);
            assert.strictEqual(ESTADO.citas.length, 1,
                `dos peticiones solapadas han escrito ${ESTADO.citas.length} citas`);
        });

        await test('el reenvío TARDÍO tampoco duplica: devuelve la misma confirmación', async () => {
            // El caso de las dos pestañas o del «atrás y volver a darle»: la primera ya
            // terminó. Sin la memoria de éxitos, esta segunda sí crearía una cita.
            const ip = ipNueva();
            const uno = await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA });
            const dos = await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA });
            assert.strictEqual(uno.raw, dos.raw);
            assert.strictEqual(ESTADO.citas.length, 1);
        });

        await test('el candado NO se pasa de listo: otra hora del mismo móvil sí se reserva', async () => {
            const ip = ipNueva();
            await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA });
            const otra = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip),
                body: { ...CUERPO_RESERVA, hora: '11:00' },
            });
            assert.strictEqual(otra.status, 200);
            assert.strictEqual(ESTADO.citas.length, 2, 'el candado ha bloqueado una reserva legítima');
        });

        await test('un «no» NO se guarda: si vuelve a darle, se mira otra vez', async () => {
            // Guardar los noes convertiría un hueco ocupado en un no pegajoso durante el TTL,
            // y la clienta que vuelve a intentarlo tiene derecho a que se mire la agenda.
            const ip = ipNueva();
            ESTADO.rechazos = ['hueco_ocupado', 'hueco_ocupado'];   // las dos estilistas
            const malo = await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA });
            assert.strictEqual(malo.status, 409);
            const bueno = await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA });
            assert.strictEqual(bueno.status, 200, 'el fallo se ha quedado pegado y ya no la deja reservar');
        });

        await test('un doble envío no gasta dos de las tres reservas por hora', async () => {
            // Por eso la clave se calcula ANTES del limitador: con tres envíos idénticos, un
            // triple toque se comía el cupo entero de esa clienta.
            const ip = ipNueva();
            for (let i = 0; i < 3; i++) {
                await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA });
            }
            const otraHora = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip),
                body: { ...CUERPO_RESERVA, hora: '12:00' },
            });
            assert.strictEqual(otraHora.status, 200, 'los repetidos han consumido el cupo de la clienta');
            assert.strictEqual(ESTADO.citas.length, 2);
        });

        await test('reservar por la clave de un SOLO_COMPLEMENTO escrita a mano → se rechaza', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()),
                body: { ...CUERPO_RESERVA, servicio: 'Peinados|Peinado con tratamientos' },
            });
            assert.strictEqual(res.body.motivo, 'servicio_no_disponible');
            assert.strictEqual(ESTADO.citas.length, 0);
        });

        await test('reservar un hueco que el motor NO ofrece → no se escribe nada', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()),
                body: { ...CUERPO_RESERVA, hora: '23:30' },
            });
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.motivo, 'hueco_no_existe');
            assert.strictEqual(res.body.recargarHuecos, true);
            assert.strictEqual(ESTADO.citas.length, 0);
        });

        // ─── EL TOPE DE CITAS: un límite, no un error ───────────────────────────────────
        await test('TOPE DE CITAS: motivo claro, WhatsApp escrito y SIN recargar huecos', async () => {
            ESTADO.rechazos = ['tope_citas'];
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.motivo, 'tope_citas');
            // Recargar los huecos sería enseñarle otra vez lo mismo que acaba de no poder
            // reservar: el problema no es el hueco.
            assert.strictEqual(res.body.recargarHuecos, false);
            assert.ok(res.body.whatsapp, 'sin WhatsApp, una clienta que reserva para ella y su hija se queda sin salida');
            assert.ok(decodeURIComponent(res.body.whatsapp).includes('ya tengo dos'));
        });

        await test('TOPE DE CITAS en los cuatro idiomas', async () => {
            for (const [lang, aguja] of [['es', 'ya tengo dos'], ['en', 'already have two'],
                                        ['ru', 'уже две записи'], ['uk', 'вже два записи']]) {
                reset();
                ESTADO.rechazos = ['tope_citas'];
                const res = await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                    headers: desde(ipNueva()), body: { ...CUERPO_RESERVA, lang },
                });
                assert.ok(decodeURIComponent(res.body.whatsapp).includes(aguja), `falta el texto en ${lang}`);
            }
        });

        await test('un idioma que no existe cae a castellano, no a un mensaje vacío', async () => {
            ESTADO.rechazos = ['tope_citas'];
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: { ...CUERPO_RESERVA, lang: 'fr' },
            });
            assert.ok(decodeURIComponent(res.body.whatsapp).includes('ya tengo dos'));
        });

        // ─── LISTA NEGRA ────────────────────────────────────────────────────────────────
        await test('LISTA NEGRA: no se escribe nada y el mensaje es NEUTRO', async () => {
            ESTADO.contacto = { id: 'c-9', blacklisted: true, tieneNombre: true };
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.motivo, 'no_confirmable_online');
            assert.ok(res.body.whatsapp);
            assert.strictEqual(ESTADO.citas.length, 0, 'se ha escrito una cita de alguien bloqueado');
            assert.strictEqual(ESTADO.leadGuardado, null, 'se le ha tocado la ficha a alguien bloqueado');
            // Ni la palabra, ni nada que se le parezca: en el salón bloquear es silencio.
            const texto = JSON.stringify(res.body).toLowerCase();
            for (const palabra of ['bloque', 'negra', 'blacklist', 'vetad', 'baneado']) {
                assert.ok(!texto.includes(palabra), `la respuesta delata el bloqueo con «${palabra}»`);
            }
        });

        await test('una lectura de lista negra ROTA no deja pasar a nadie', async () => {
            const orig = db.getContactoParaReservaWeb;
            db.getContactoParaReservaWeb = async () => { throw new Error('supabase caído'); };
            try {
                const res = await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                    headers: desde(ipNueva()), body: CUERPO_RESERVA,
                });
                assert.strictEqual(res.status, 500);
                assert.strictEqual(ESTADO.citas.length, 0, 'con la comprobación rota se ha reservado igual');
            } finally { db.getContactoParaReservaWeb = orig; }
        });

        // ─── EL NOMBRE GUARDADO NO SE PISA ──────────────────────────────────────────────
        await test('con ficha que YA tiene nombre, el formulario no lo cambia', async () => {
            ESTADO.contacto = { id: 'c-1', blacklisted: false, tieneNombre: true };
            await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: { ...CUERPO_RESERVA, nombre: 'Nombre Falso' },
            });
            assert.ok(!('nombre' in ESTADO.leadGuardado),
                'cualquiera podría renombrar la ficha de otra tecleando su teléfono');
        });

        await test('con ficha SIN nombre, el que teclea sí se guarda', async () => {
            ESTADO.contacto = { id: 'c-1', blacklisted: false, tieneNombre: false };
            await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(ESTADO.leadGuardado.nombre, 'Marta');
        });

        // ─── EL CLAIM PERDIDO ───────────────────────────────────────────────────────────
        await test('«la primera que haya»: si la primera pierde la carrera, se prueba la siguiente', async () => {
            ESTADO.rechazos = ['hueco_ocupado'];
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.cita.estilista, 'Natalia');
            assert.deepStrictEqual(ESTADO.citas.map(c => c.stylistId), [IRINA, NATALIA]);
        });

        await test('con estilista ELEGIDA no se reintenta con otra: la confirmación no puede cambiar de nombre', async () => {
            ESTADO.rechazos = ['hueco_ocupado'];
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: { ...CUERPO_RESERVA, estilista: IRINA },
            });
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.motivo, 'hueco_ocupado');
            assert.strictEqual(res.body.recargarHuecos, true);
            assert.deepStrictEqual(ESTADO.citas.map(c => c.stylistId), [IRINA], 'se ha reservado con otra estilista');
        });

        await test('el tope de citas NO se reintenta con otra estilista: no es del hueco', async () => {
            ESTADO.rechazos = ['tope_citas', 'tope_citas'];
            await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(ESTADO.citas.length, 1, 'se ha vuelto a intentar un tope que no depende de la estilista');
        });

        // ─── EL LIMITADOR ───────────────────────────────────────────────────────────────
        await test('LÍMITE POR IP: la cuarta reserva de la misma IP en una hora → 429', async () => {
            const ip = ipNueva();
            const horas = ['10:00', '11:00', '12:00'];
            for (let i = 0; i < 3; i++) {
                const ok = await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip),
                    body: { ...CUERPO_RESERVA, hora: horas[i] },
                });
                assert.strictEqual(ok.status, 200, `la reserva ${i + 1} debería pasar`);
            }
            const cuarta = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip),
                body: { ...CUERPO_RESERVA, hora: '13:00' },
            });
            assert.strictEqual(cuarta.status, 429);
            assert.strictEqual(cuarta.body.motivo, 'demasiadas_peticiones');
            assert.ok(cuarta.body.whatsapp, 'sin salida, una clienta legítima limitada se queda sin poder hacer nada');
            assert.ok(Number.isFinite(cuarta.body.esperaSegundos));
            assert.strictEqual(ESTADO.citas.length, 3, 'la reserva limitada llegó a escribirse');
        });

        await test('el límite es POR IP: otra clienta desde otra IP sigue pudiendo reservar', async () => {
            const ip = ipNueva();
            for (const hora of ['10:00', '11:00', '12:00', '13:00']) {
                await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip),
                    body: { ...CUERPO_RESERVA, hora },
                });
            }
            const otra = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(otra.status, 200, 'una IP pegando deja fuera a las demás clientas');
        });

        await test('las LECTURAS tienen su propio cupo, muy por encima del de reservar', async () => {
            // Con el 3/h de las reservas, pintar un mes rompería la página en el primer
            // minuto. Diez lecturas seguidas de la misma IP tienen que pasar.
            const ip = ipNueva();
            for (let i = 0; i < 10; i++) {
                const res = await request(server, { path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ip) });
                assert.strictEqual(res.status, 200, `la lectura ${i + 1} se ha limitado`);
            }
        });

        await test('un tope de 0 puesto por la dueña CIERRA de verdad, no cae al default', async () => {
            ESTADO.config.reservas_web_max_hora_ip = 0;
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                headers: desde(ipNueva()), body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.status, 429);
            assert.strictEqual(ESTADO.citas.length, 0);
        });

        await test('TECHO DE LA ORG: se agota aunque venga de IPs distintas', async () => {
            ESTADO.config.reservas_web_max_hora_org = 2;
            const vistos = [];
            const horasOrg = ['10:00', '11:00', '12:00', '13:00'];
            for (let i = 0; i < 4; i++) {
                const res = await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                    headers: desde(ipNueva()), body: { ...CUERPO_RESERVA, hora: horasOrg[i] },
                });
                vistos.push(res.status === 200 ? 'ok' : res.body.motivo);
            }
            assert.deepStrictEqual(vistos, ['ok', 'ok', 'salon_saturado', 'salon_saturado']);
        });
        // ─── EL TELÉFONO, POR EL CAMINO DE VERDAD ───────────────────────────────────────
        //
        // La composición se prueba unidad a unidad en tests/reserva-web-telefono.test.js.
        // Aquí se comprueba lo otro: que el handler la USA, y que lo que llega a `saveLead`
        // y a la ficha es la forma canónica y no lo que se tecleó.

        await test('lo que se guarda lleva el prefijo del PAÍS, no el que adivine el servidor', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()),
                // El número del incidente: un móvil ucraniano de nueve dígitos que empieza
                // por 6. Antes salía 34671234567 — un móvil español de otra persona.
                body: { ...CUERPO_RESERVA, prefijo: '380', telefono: '67 123 45 67' },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(ESTADO.leadGuardado.telefono, '380671234567');
            assert.notStrictEqual(ESTADO.leadGuardado.telefono, '34671234567',
                'ha vuelto a convertirse en un móvil español');
        });

        await test('el móvil español sigue guardándose exactamente igual que ayer', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()),
                body: CUERPO_RESERVA,
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(ESTADO.leadGuardado.telefono, '34600111222');
        });

        await test('sin `prefijo` NO se le tira la reserva: se hace lo de ayer', async () => {
            // Un navegador con el bundle viejo, en los minutos de un despliegue. Cambiar un
            // fallo silencioso por un 400 encima de alguien que no ha hecho nada mal sería
            // peor. Queda el log `reserva_web_telefono_sin_prefijo` para saber si pasa.
            const body = { ...CUERPO_RESERVA };
            delete body.prefijo;
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()), body,
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(ESTADO.leadGuardado.telefono, '34600111222');
        });

        await test('un número que no cuadra con su país se para ANTES de escribir nada', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()),
                body: { ...CUERPO_RESERVA, prefijo: '34', telefono: '600' },
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.motivo, 'datos_invalidos');
            assert.strictEqual(ESTADO.leadGuardado, null, 'ha creado ficha con un teléfono inservible');
            assert.strictEqual(ESTADO.citas.length, 0);
        });

        await test('un prefijo inventado no se pega delante del número', async () => {
            const res = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ipNueva()),
                body: { ...CUERPO_RESERVA, prefijo: '99999', telefono: '600111222' },
            });
            // Cae en la rama «sin prefijo», o sea la conducta de ayer: nunca 99999600111222.
            assert.strictEqual(res.status, 200);
            assert.strictEqual(ESTADO.leadGuardado.telefono, '34600111222');
        });

        // ─── LO QUE LA PANTALLA NECESITA DEL CATÁLOGO ───────────────────────────────────

        await test('el catálogo trae la lista de países del selector', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.paises) && res.body.paises.length > 1);
            assert.strictEqual(res.body.paises[0].codigo, '34', 'España primero: es el 95 %');
            // Y solo lo que la pantalla necesita: nada de las piezas de la composición.
            for (const p of res.body.paises) {
                assert.deepStrictEqual(Object.keys(p).sort(), ['codigo', 'iso', 'minimo']);
            }
        });

        await test('el NOMBRE del servicio va en castellano en los cuatro idiomas', async () => {
            // Es la cadena que se escribirá en `appointments.service`. La misma en ruso que
            // en castellano, porque es la que el salón lee en la agenda y la que ella tendrá
            // que pedir al llegar.
            const nombres = {};
            for (const lang of ['es', 'en', 'ru', 'uk']) {
                const res = await request(server, {
                    path: `/reserva-web/${SLUG}/catalogo?lang=${lang}`, headers: desde(ipNueva()),
                });
                nombres[lang] = res.body.servicios.map(s => s.nombreCompleto).join('|');
            }
            assert.strictEqual(nombres.ru, nombres.es, 'el nombre del servicio se ha traducido');
            assert.strictEqual(nombres.uk, nombres.es);
            assert.strictEqual(nombres.en, nombres.es);
            assert.ok(nombres.es.includes('Corte mujer y secado'));
        });

        await test('la explicación: hoy NO sale, porque la escribe la dueña', async () => {
            // El catálogo de producción no la tiene (verificado el 21/08/2026 sobre las 82
            // entradas). Sin texto escrito, el campo ni siquiera viaja: la pantalla no puede
            // pintar un renglón en blanco debajo de cada servicio.
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            for (const s of res.body.servicios) {
                assert.ok(!('explicacion' in s), `${s.nombre}: explicación inventada`);
            }
        });

        await test('cuando la dueña la escriba, sale en SU idioma y cae al castellano', async () => {
            ESTADO.businessInfo = { ...ESTADO.businessInfo };
            const original = db.getAgentConfig;
            db.getAgentConfig = async () => ({
                business_info: ESTADO.businessInfo,
                services: [
                    { categoria: 'Color', nombre: 'Mechas Balayage', precio: 180, duracion: 240,
                      explicacion: { es: 'Aclarado a mano', ru: 'Осветление вручную' } },
                    // Atajo: una cadena vale por el castellano, para que se pueda escribir
                    // primero uno y traducir después sin que la pantalla se quede muda.
                    { categoria: 'Cortes', nombre: 'Corte mujer', precio: 35, duracion: 60,
                      explicacion: 'Corte y peinado' },
                ],
            });
            try {
                const ru = await request(server, {
                    path: `/reserva-web/${SLUG}/catalogo?lang=ru`, headers: desde(ipNueva()),
                });
                const porNombre = Object.fromEntries(ru.body.servicios.map(s => [s.nombre, s.explicacion]));
                assert.strictEqual(porNombre['Mechas Balayage'], 'Осветление вручную');
                assert.strictEqual(porNombre['Corte mujer'], 'Corte y peinado',
                    'sin ruso escrito, el castellano es mejor que nada');
                // Y el nombre sigue sin traducirse, que es la mitad de la decisión.
                assert.ok(ru.body.servicios.some(s => s.nombre === 'Mechas Balayage'));
            } finally { db.getAgentConfig = original; }
        });

    } finally {
        server.close();
    }
})();
