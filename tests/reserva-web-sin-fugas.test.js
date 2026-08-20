/**
 * tests/reserva-web-sin-fugas.test.js — Que por el enlace público no salga NADA de nadie.
 *
 * Estas cuatro rutas las llama cualquiera que tenga la URL. No hay sesión, no hay clienta
 * identificada y no hay nadie mirando. Un campo de más aquí no es un bug de formato: es el
 * nombre o el teléfono de una clienta del salón en una página que se puede abrir desde
 * cualquier sitio.
 *
 * ── Cómo está hecho, y por qué así ───────────────────────────────────────────────────────
 *
 * No se comprueba campo por campo lo que SÍ sale —eso es lo que hace el otro fichero— sino
 * al revés: se ENVENENAN los datos con cadenas imposibles de confundir, en TODOS los sitios
 * de los que podría salir una fuga, y luego se afirma que ninguna respuesta contiene ninguna.
 *
 * La diferencia importa. Una lista de campos permitidos hay que acordarse de actualizarla; el
 * veneno no: si alguien cambia una proyección por un `{...fila}`, el nombre de la clienta
 * aparece en la respuesta y el test se cae solo, sin que nadie haya tenido que preverlo. Es
 * la protección contra el fallo REAL, que no es «alguien publica un campo a propósito» sino
 * «alguien añade un campo a `agent_configs.services` desde el panel y nadie se entera de que
 * ha salido a internet».
 *
 * ── Sabotajes medidos (20/08/2026) ───────────────────────────────────────────────────────
 *   · `catalogoPublico` devolviendo `{...s}` en vez de enumerar campos ........... 2 rojos
 *   · `huecosPublicos` conservando `texto` ....................................... 1 rojo
 *   · el handler devolviendo `e.message` en el error interno ..................... 1 rojo
 *   · el handler devolviendo la FILA de `appointments` en vez de la proyección ... 5 rojos
 *     (el fallo realista: sale de «simplificar» el acuse a `res.json({ok:true, cita})`,
 *      y esa fila lleva `full_name`, `phone`, `notes` y `contact_id`)
 *
 * Un intento de sabotaje NO salió en rojo, y merece quedar escrito porque explica el diseño:
 * añadirle un campo `full_name` a `reservaPublica` no filtra nada, porque el nombre NUNCA
 * llega hasta ahí — `getContactoParaReservaWeb` está escrito para no devolverlo. La
 * protección no es que el handler se acuerde de no publicarlo: es que no lo tiene.
 */
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RESERVA_WEB_TOKEN = 'token-de-prueba-32-caracteres-xx';

const assert = require('assert');
const http = require('http');

const telegramPath = require.resolve('../services/telegram');
require.cache[telegramPath] = {
    id: telegramPath, filename: telegramPath, loaded: true,
    exports: { notifyBlacklistAlert: async () => {}, startTelegramBot: () => {}, notifyEscalation: async () => {} },
};

const db = require('../services/db');
const calendarSante = require('../services/calendar-sante');
const { app, _limitadorReservas } = require('../webhook');

const SLUG = 'sante-healthy-hair-salon';
const TOKEN = process.env.RESERVA_WEB_TOKEN;
const IRINA = 'c3d4e5f6-0000-0000-0000-000000000101';

// ─── El veneno ───────────────────────────────────────────────────────────────────────────
//
// Cada cadena está en un sitio distinto del que una fuga podría venir. Son deliberadamente
// absurdas: si alguna aparece en una respuesta, no hay duda de que ha salido de donde se
// puso, y el mensaje del fallo dice de cuál se trata.
const VENENO = {
    nombreClienta:      'ZZNOMBRECLIENTAZZ',      // contacts.full_name
    telefonoClienta:    'ZZ600999888ZZ',          // contacts.wa_phone
    notaInternaServicio:'ZZNOTAINTERNAZZ',        // un campo nuevo en agent_configs.services
    costeServicio:      'ZZCOSTEZZ',              // el precio de coste, que no es el de venta
    promptDelAgente:    'ZZSYSTEMPROMPTZZ',       // agent_configs.system_prompt
    infoInterna:        'ZZBUSINESSINFOZZ',       // agent_configs.business_info
    upselling:          'ZZUPSELLINGZZ',          // las reglas de marketing
    otraOrg:            'ZZOTRAORGZZ',            // datos de la otra organización
    mensajeDeError:     'ZZTRAZASUPABASEZZ',      // el e.message de un fallo interno
    textoDelSlot:       'ZZTEXTOPARAELMODELOZZ',  // el `texto` que el motor fabrica
};

const CATALOGO = [
    {
        categoria: 'Cortes', nombre: 'Corte mujer', precio: 35, duracion: 60,
        // Un campo que hoy no existe y que la dueña podría escribir mañana sobre el JSONB.
        nota_interna: VENENO.notaInternaServicio,
        precio_coste: VENENO.costeServicio,
    },
    { categoria: 'Color', nombre: 'Mechas Balayage', precio: 180, duracion: 240 },
];

const CONFIG_AGENTE = {
    services: CATALOGO,
    system_prompt: VENENO.promptDelAgente,
    business_info: { companyName: 'Sante', notas_internas: VENENO.infoInterna, upselling: [VENENO.upselling] },
    business_hours: { lunes: '10:00-19:00' },
};

let ESTADO;
function reset() {
    _limitadorReservas._reset();
    ESTADO = {
        contacto: { id: 'c-1', blacklisted: false, tieneNombre: true },
        romper: null,
    };
}

db.getAllConfig = async () => ({
    reservas_web_activo: true,
    reservas_web_max_hora_ip: 50,
    reservas_web_max_hora_org: 500,
    reservas_web_max_hora_lecturas_ip: 500,
    // Config de la org que NO tiene nada que hacer en una respuesta pública.
    telegram_admins: [VENENO.otraOrg],
    plantilla_recordatorio: VENENO.otraOrg,
});
db.getAgentConfig = async () => {
    if (ESTADO.romper === 'catalogo') throw new Error(`relation "contacts" does not exist: ${VENENO.mensajeDeError}`);
    return CONFIG_AGENTE;
};
db.getContactoParaReservaWeb = async () => ESTADO.contacto;
db.saveLead = async () => 'contact-1';
db.saveAppointment = async () => ({
    // La fila que devuelve la base de datos SÍ lleva datos personales: es lo que hay en
    // `appointments`. La proyección tiene que dejarlos fuera.
    id: 'cita-1',
    full_name: VENENO.nombreClienta,
    phone: VENENO.telefonoClienta,
    notes: 'ZZNOTASDELACITAZZ',
    contact_id: 'c-1',
    starts_at: '2026-09-10T10:00:00+02:00',
});

const SLOT = {
    fecha: '2026-09-10', hora: '10:00', diaNombre: 'jueves',
    stylistId: IRINA, stylistName: 'Irina',
    texto: VENENO.textoDelSlot,
    alternativas: [{ id: IRINA, name: 'Irina' }],
};
calendarSante.getAvailableSlots = async () => {
    const out = [{ ...SLOT }];
    out.causa = null; out.requestedDayUnavailable = false;
    return out;
};
calendarSante.getAvailableDays = async () => {
    const out = [{ fecha: '2026-09-10', diaSemana: 3, huecos: 4, estilistas: [{ id: IRINA, name: 'Irina' }] }];
    out.causa = null;
    return out;
};

function request(server, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
    const { port } = server.address();
    const datos = body === null ? null : JSON.stringify(body);
    const cab = { 'X-Reserva-Token': TOKEN, 'X-Cliente-IP': '10.1.1.1', ...headers };
    if (datos) { cab['Content-Type'] = 'application/json'; cab['Content-Length'] = Buffer.byteLength(datos); }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: cab }, (res) => {
            let d = '';
            res.on('data', c => (d += c));
            res.on('end', () => resolve({ status: res.statusCode, raw: d, body: d ? JSON.parse(d) : null }));
        });
        req.on('error', reject);
        if (datos) req.write(datos);
        req.end();
    });
}

/** El corazón del fichero: ninguna cadena envenenada puede estar en el cuerpo, mire donde mire. */
function sinVeneno(res, contexto) {
    for (const [donde, aguja] of Object.entries(VENENO)) {
        assert.ok(!res.raw.includes(aguja),
            `${contexto}: se ha filtrado «${donde}» (${aguja}) en la respuesta:\n${res.raw.slice(0, 400)}`);
    }
}

const SERVICIO_Q = encodeURIComponent('Cortes|Corte mujer');
const CUERPO = {
    servicio: 'Cortes|Corte mujer', fecha: '2026-09-10', hora: '10:00',
    nombre: 'Marta', telefono: '600111222',
};

async function test(name, fn) {
    try { reset(); await fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
}

(async () => {
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        await test('CATÁLOGO: ni notas internas, ni precio de coste, ni prompt, ni business_info', async () => {
            const res = await request(server, { path: `/reserva-web/${SLUG}/catalogo` });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.servicios.length > 0, 'sin servicios el test no prueba nada');
            sinVeneno(res, 'catálogo');
        });

        await test('DÍAS: ninguna cadena envenenada', async () => {
            const res = await request(server, { path: `/reserva-web/${SLUG}/dias?servicio=${SERVICIO_Q}` });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.dias.length > 0);
            sinVeneno(res, 'días');
        });

        await test('HUECOS: tampoco el `texto` que el motor fabrica para el modelo', async () => {
            const res = await request(server, { path: `/reserva-web/${SLUG}/huecos?servicio=${SERVICIO_Q}&fecha=2026-09-10` });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.huecos.length > 0);
            sinVeneno(res, 'huecos');
        });

        await test('RESERVA: el acuse no lleva NADA de la fila que devolvió la base de datos', async () => {
            const res = await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, body: CUERPO });
            assert.strictEqual(res.status, 200);
            sinVeneno(res, 'reserva');
            // Y en concreto: no saluda por el nombre guardado. Si el teléfono casa con una
            // ficha, la página NO puede decir cómo se llama esa persona — eso filtraría el
            // nombre de una clienta a cualquiera que teclee su número.
            assert.ok(!res.raw.includes('full_name'));
            assert.ok(!res.raw.includes('phone'));
            assert.ok(!res.raw.includes('contact_id'));
        });

        await test('la reserva devuelve lo que ELLA eligió, no lo que había guardado', async () => {
            const res = await request(server, { method: 'POST', path: `/reserva-web/${SLUG}/reserva`, body: CUERPO });
            assert.deepStrictEqual(Object.keys(res.body).sort(), ['cita', 'ok']);
            assert.deepStrictEqual(
                Object.keys(res.body.cita).sort(),
                ['duracionMin', 'estilista', 'fecha', 'hora', 'servicio', 'zonaHoraria'],
            );
        });

        await test('un fallo interno NO devuelve el mensaje de la excepción', async () => {
            // Un `e.message` de Supabase lleva nombres de tabla, de constraint y a veces
            // trozos de fila. A una página pública va un motivo pelado.
            ESTADO.romper = 'catalogo';
            const res = await request(server, { path: `/reserva-web/${SLUG}/catalogo` });
            assert.strictEqual(res.status, 500);
            sinVeneno(res, 'error interno');
            assert.ok(!res.raw.includes('relation'), 'la respuesta lleva el mensaje de Postgres');
            assert.deepStrictEqual(Object.keys(res.body).sort(), ['motivo', 'ok', 'recargarHuecos', 'whatsapp']);
        });

        await test('NINGUNA de las cuatro rutas menciona la otra organización', async () => {
            // Los endpoints reciben un slug, y de ahí sale UNA org. Nada de lo que se
            // devuelve puede venir de la otra, ni siquiera su nombre.
            for (const path of [
                `/reserva-web/${SLUG}/catalogo`,
                `/reserva-web/${SLUG}/dias?servicio=${SERVICIO_Q}`,
                `/reserva-web/${SLUG}/huecos?servicio=${SERVICIO_Q}&fecha=2026-09-10`,
            ]) {
                const res = await request(server, { path });
                assert.ok(!res.raw.includes('San Remo') && !res.raw.includes('a1b2c3d4'),
                    `${path} menciona la otra organización`);
            }
        });

        await test('ninguna respuesta lleva un UUID de organización ni de contacto', async () => {
            // El id de la ESTILISTA sí sale, y hace falta para reservar con ella. El de la
            // org y el del contacto no hacen falta para nada y no salen.
            for (const [method, path, body] of [
                ['GET', `/reserva-web/${SLUG}/catalogo`, null],
                ['GET', `/reserva-web/${SLUG}/dias?servicio=${SERVICIO_Q}`, null],
                ['POST', `/reserva-web/${SLUG}/reserva`, CUERPO],
            ]) {
                reset();
                const res = await request(server, { method, path, body });
                assert.ok(!res.raw.includes('b2c3d4e5-f6a7-8901-bcde-f12345678901'),
                    `${path} devuelve el UUID de la organización`);
                assert.ok(!res.raw.includes('contact-1') && !res.raw.includes('cita-1'),
                    `${path} devuelve un identificador interno`);
            }
        });

        await test('un 404 de slug desconocido no lleva ni eco de lo que se pidió', async () => {
            // Sin esto, un slug con HTML dentro volvería reflejado — y de paso confirmaría
            // qué se probó. Se responde con una constante.
            const res = await request(server, { path: '/reserva-web/ZZSONDAZZ/catalogo' });
            assert.strictEqual(res.status, 404);
            assert.ok(!res.raw.includes('ZZSONDAZZ'));
            assert.deepStrictEqual(res.body, { ok: false, motivo: 'no_encontrado' });
        });
    } finally {
        server.close();
    }
})();
