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
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const db = require('../services/db');
const calendarSante = require('../services/calendar-sante');
const { app, _limitadorReservas } = require('../webhook');

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
    ESTADO = {
        config: {
            reservas_web_activo: true,
            reservas_web_max_hora_ip: 3,
            reservas_web_max_hora_org: 10,
            reservas_web_max_futuras: 2,
            reservas_web_max_hora_lecturas_ip: 120,
        },
        contacto: null,           // lo que devuelve getContactoParaReservaWeb
        leadGuardado: null,       // lo que recibió saveLead
        citas: [],                // lo que recibió saveAppointment
        rechazos: [],             // motivos a lanzar, en orden, uno por intento
        slots: [{ fecha: '2026-09-10', hora: '10:00', diaNombre: 'jueves', stylistId: IRINA, stylistName: 'Irina',
                  alternativas: [{ id: IRINA, name: 'Irina' }, { id: NATALIA, name: 'Natalia' }] }],
        dias: [{ fecha: '2026-09-10', diaSemana: 3, huecos: 4,
                 estilistas: [{ id: IRINA, name: 'Irina' }, { id: NATALIA, name: 'Natalia' }] }],
    };
}

db.getAllConfig = async () => ESTADO.config;
db.getAgentConfig = async () => ({ services: CATALOGO });
db.getContactoParaReservaWeb = async () => ESTADO.contacto;
db.saveLead = async (_org, datos) => { ESTADO.leadGuardado = datos; return 'contact-1'; };
db.saveAppointment = async (_org, contactId, opts) => {
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
    nombre: 'Marta', telefono: '600111222', lang: 'es',
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
            assert.deepStrictEqual(nombres.sort(), ['Corte mujer', 'Mechas Balayage']);
            assert.ok(!nombres.includes('Peinado con tratamientos'), 'un solo_complemento se ofrece en la web');
            assert.ok(!nombres.includes('Tinte retirado'), 'un servicio de baja se ofrece en la web');
            assert.ok(!nombres.includes('Consulta de valoración'), 'la Consulta reactive-only se ofrece en la web');
        });

        await test('el catálogo lleva SOLO los cuatro campos que la página necesita', async () => {
            const res = await request(server, {
                path: `/reserva-web/${SLUG}/catalogo`, headers: desde(ipNueva()),
            });
            for (const s of res.body.servicios) {
                assert.deepStrictEqual(Object.keys(s).sort(), ['categoria', 'duracion', 'key', 'nombre', 'precio']);
            }
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
            for (let i = 0; i < 3; i++) {
                const ok = await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA,
                });
                assert.strictEqual(ok.status, 200, `la reserva ${i + 1} debería pasar`);
            }
            const cuarta = await request(server, {
                method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA,
            });
            assert.strictEqual(cuarta.status, 429);
            assert.strictEqual(cuarta.body.motivo, 'demasiadas_peticiones');
            assert.ok(cuarta.body.whatsapp, 'sin salida, una clienta legítima limitada se queda sin poder hacer nada');
            assert.ok(Number.isFinite(cuarta.body.esperaSegundos));
            assert.strictEqual(ESTADO.citas.length, 3, 'la reserva limitada llegó a escribirse');
        });

        await test('el límite es POR IP: otra clienta desde otra IP sigue pudiendo reservar', async () => {
            const ip = ipNueva();
            for (let i = 0; i < 4; i++) {
                await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, headers: desde(ip), body: CUERPO_RESERVA });
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
            for (let i = 0; i < 4; i++) {
                const res = await request(server, {
                    method: 'POST', path: `/reserva-web/${SLUG}/reserva`,
                    headers: desde(ipNueva()), body: CUERPO_RESERVA,
                });
                vistos.push(res.status === 200 ? 'ok' : res.body.motivo);
            }
            assert.deepStrictEqual(vistos, ['ok', 'ok', 'salon_saturado', 'salon_saturado']);
        });
    } finally {
        server.close();
    }
})();
