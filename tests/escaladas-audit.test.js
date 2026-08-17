// La lógica pura de `informe:escaladas` (tests/lib/escaladas-audit.js).
//
// El informe existe porque la medida que hacía falta YA ESTABA en Supabase y no requería
// contadores nuevos: `pending_actions.payload.motivo` lleva el prefijo `consulta_` si y solo
// si la escalada la resolvió el protocolo de dos turnos. Y tenía que estar en Supabase, no en
// metrics.json: medido sobre el reflog de origin/main, en 30 días el hueco MAYOR entre dos
// pushes fue de 1,88 días y en 90 el mayor de todos fue de 7,00 — nunca ha habido 14 días sin
// desplegar, así que un umbral de dos semanas sobre un fichero que se borra en cada deploy era
// inalcanzable POR CONSTRUCCIÓN.
//
// Los dos bloques centrales son REGRESIONES de fallos que este informe tuvo en su primera
// corrida contra producción, con los textos reales que los produjeron:
//   · tres de las siete filas se leían al revés porque isAffirmative casa por SUBCADENA
//     («confu-SI-ón», «повре-ЖДА-ются») y una queja entera pasaba por un «sí»;
//   · el contador del coda daba un falso positivo con la plantilla CONSULTA_ASK, que hace la
//     MISMA pregunta pero en una sola línea.
//
// Visto fallar sin lo que protege (sabotajes con cp previo, rojos MEDIDOS el 18/08/2026):
//   · quitar el gate `esOferta` (volver a isAffirmative a secas) → 2 rojos, los dos textos reales;
//   · contar el coda por `includes` en vez de por el salto de línea → 1 rojo (CONSULTA_ASK);
//   · tratar un motivo `consulta_*` como inmediata → 1 rojo.

const assert = require('assert');
const { auditEscaladas, contarCodas } = require('./lib/escaladas-audit');

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

const T = (min) => new Date(Date.UTC(2026, 7, 12, 10, min, 0)).toISOString();
const CONTACTO = { id: 'c1', full_name: 'Clienta', wa_phone: '34600000000', language: 'es' };

// El detector real del bot, para que el gemelo no invente su propia idea de «oferta».
const { detectaOfertaTraspaso } = require('../bot')._internals;

test('el prefijo `consulta_` marca el protocolo de dos turnos', () => {
    const { filas } = auditEscaladas({
        pendingActions: [
            { id: 'p1', type: 'escalation', contact_id: 'c1', created_at: T(10), payload: { motivo: 'consulta_dato_no_disponible' } },
            { id: 'p2', type: 'escalation', contact_id: 'c1', created_at: T(20), payload: { motivo: 'queja_cita' } },
        ],
        entrantes: [{ contactId: 'c1', content: 'sí', createdAt: T(9) }],
        contactos: [CONTACTO],
        salientes: [],
        esOferta: detectaOfertaTraspaso,
    });
    assert.strictEqual(filas[0].via, 'espera');
    assert.strictEqual(filas[0].lectura, 'protocolo_completo');
    assert.strictEqual(filas[1].via, 'inmediata');
});

test('solo cuentan las filas de tipo escalation', () => {
    const { filas } = auditEscaladas({
        pendingActions: [
            { id: 'p1', type: 'bizum_review', contact_id: 'c1', created_at: T(10), payload: { motivo: 'x' } },
        ],
        contactos: [CONTACTO], esOferta: detectaOfertaTraspaso,
    });
    assert.strictEqual(filas.length, 0);
});

// ─── Regresión 1: el falso «sí» de isAffirmative sobre mensajes largos ──────────────────

test('REGRESIÓN · una queja larga NO es un «sí» (Tania Daza, 02/08, real)', () => {
    // Sin el gate de oferta, isAffirmative encuentra «si» dentro de la palabra «confusión»
    // (y otras) y la queja entera se leía como «ella ya había dicho que sí».
    const queja = 'Me en cuanto sumamente triste y decepcionada con mi tinte y retoque de color. '
        + 'Hubo una confusión con lo que pedí y no me gusta el resultado, quiero una solución.';
    const { filas } = auditEscaladas({
        pendingActions: [{ id: 'p1', type: 'escalation', contact_id: 'c1', created_at: T(20), payload: { motivo: 'queja_cita' } }],
        entrantes: [{ contactId: 'c1', content: queja, createdAt: T(19) }],
        // El bot venía hablando de otra cosa: NO hubo oferta que contestar.
        salientes: [{ contactId: 'c1', content: '¿Qué día te viene mejor? 😊', createdAt: T(18) }],
        contactos: [CONTACTO],
        esOferta: detectaOfertaTraspaso,
    });
    assert.strictEqual(filas[0].lectura, 'sin_preguntar',
        'una queja no es una aceptación: el bot escaló sin preguntar');
});

test('REGRESIÓN · un mensaje ruso largo tampoco (Nastya, 09/08, real)', () => {
    // «повреждаются» lleva «да» dentro.
    const ruso = 'Как это проходит и как можно гарантировать что волосы ни как не повреждаются';
    const { filas } = auditEscaladas({
        pendingActions: [{ id: 'p1', type: 'escalation', contact_id: 'c1', created_at: T(20), payload: { motivo: 'servicio_especial' } }],
        entrantes: [{ contactId: 'c1', content: ruso, createdAt: T(19) }],
        salientes: [{ contactId: 'c1', content: 'Да, это безопасная процедура 😊', createdAt: T(18) }],
        contactos: [{ ...CONTACTO, language: 'ru' }],
        esOferta: detectaOfertaTraspaso,
    });
    assert.strictEqual(filas[0].lectura, 'sin_preguntar');
    assert.strictEqual(filas[0].idioma, 'ru', 'el idioma tiene que viajar: el agregado esconde el reparto');
});

test('un «sí» SÍ cuenta cuando el saliente anterior ofrecía de verdad', () => {
    const { filas } = auditEscaladas({
        pendingActions: [{ id: 'p1', type: 'escalation', contact_id: 'c1', created_at: T(20), payload: { motivo: 'queja_cita' } }],
        entrantes: [{ contactId: 'c1', content: 'Si por favor gracias', createdAt: T(19) }],
        salientes: [{ contactId: 'c1', content: '¿Quieres que te ponga en contacto con una de nuestras especialistas?', createdAt: T(18) }],
        contactos: [CONTACTO],
        esOferta: detectaOfertaTraspaso,
    });
    assert.strictEqual(filas[0].lectura, 'tras_si');
});

test('sin ningún entrante previo se dice, no se adivina', () => {
    const { filas } = auditEscaladas({
        pendingActions: [{ id: 'p1', type: 'escalation', contact_id: 'c1', created_at: T(20), payload: { motivo: 'queja_cita' } }],
        entrantes: [], salientes: [], contactos: [CONTACTO], esOferta: detectaOfertaTraspaso,
    });
    assert.strictEqual(filas[0].lectura, 'sin_entrante');
});

test('la ventana --desde recorta por fecha y el resumen la respeta', () => {
    const pendingActions = [
        { id: 'viejo', type: 'escalation', contact_id: 'c1', created_at: T(0), payload: { motivo: 'queja_cita' } },
        { id: 'nuevo', type: 'escalation', contact_id: 'c1', created_at: T(50), payload: { motivo: 'queja_cita' } },
    ];
    const desdeMs = new Date(T(25)).getTime();
    const { filas, resumen } = auditEscaladas({
        pendingActions, entrantes: [], salientes: [], contactos: [CONTACTO],
        esOferta: detectaOfertaTraspaso, desdeMs,
    });
    assert.strictEqual(filas.length, 1);
    assert.strictEqual(filas[0].id, 'nuevo');
    assert.strictEqual(resumen.total, 1);
});

test('el reparto por idioma se agrupa por motivo Y por idioma', () => {
    const { resumen } = auditEscaladas({
        pendingActions: [
            { id: 'a', type: 'escalation', contact_id: 'c1', created_at: T(10), payload: { motivo: 'queja_cita' } },
            { id: 'b', type: 'escalation', contact_id: 'c2', created_at: T(11), payload: { motivo: 'queja_cita' } },
        ],
        entrantes: [
            { contactId: 'c1', content: 'esto es un desastre', createdAt: T(9) },
            { contactId: 'c2', content: 'жалоба на прошлый визит', createdAt: T(9) },
        ],
        salientes: [],
        contactos: [CONTACTO, { id: 'c2', full_name: 'Otra', wa_phone: '34600000001', language: 'ru' }],
        esOferta: detectaOfertaTraspaso,
    });
    assert.deepStrictEqual(resumen.sinPreguntarPorIdioma.queja_cita, { es: 1, ru: 1 });
});

test('sin idioma en la ficha va a su propio cubo, no se pliega sobre «es»', () => {
    const { resumen } = auditEscaladas({
        pendingActions: [{ id: 'a', type: 'escalation', contact_id: 'c9', created_at: T(10), payload: { motivo: 'queja_cita' } }],
        entrantes: [{ contactId: 'c9', content: 'esto no me ha gustado nada', createdAt: T(9) }],
        salientes: [], contactos: [{ id: 'c9', full_name: null, wa_phone: null, language: null }],
        esOferta: detectaOfertaTraspaso,
    });
    assert.deepStrictEqual(resumen.sinPreguntarPorIdioma.queja_cita, { sin_idioma: 1 });
});

// ─── Regresión 2: el coda se cuenta por el salto de línea ───────────────────────────────

const PREGUNTAS = { es: '¿Quieres que te ponga en contacto con una de nuestras especialistas?' };
const FORMAL = { es: '¿Quiere que le ponga en contacto con una de nuestras especialistas?' };

test('REGRESIÓN · la plantilla CONSULTA_ASK NO es un coda (misma pregunta, una sola línea)', () => {
    const plantilla = 'La permanente requiere una valoración personalizada 😊 '
        + '¿Quieres que te ponga en contacto con una de nuestras especialistas?';
    const { total } = contarCodas([{ content: plantilla, createdAt: T(1) }], PREGUNTAS, FORMAL);
    assert.strictEqual(total, 0,
        'contar por `includes` metía la plantilla de la permanente de Mafe (08/08) e inflaba el anillo 2');
});

test('un coda de verdad SÍ se cuenta (va pegado tras un salto de línea)', () => {
    const conCoda = 'Eso no lo tengo yo, pero el equipo te lo confirma en el salón 😊 ¿Reservamos tu cita primero?'
        + '\n¿Quieres que te ponga en contacto con una de nuestras especialistas?';
    const { total, salientes } = contarCodas([{ content: conCoda, createdAt: T(1) }], PREGUNTAS, FORMAL);
    assert.strictEqual(total, 1);
    assert.strictEqual(salientes.length, 1);
});

test('el coda en variante de usted también cuenta', () => {
    const conCoda = 'Eso no lo tengo yo 😊\n¿Quiere que le ponga en contacto con una de nuestras especialistas?';
    assert.strictEqual(contarCodas([{ content: conCoda, createdAt: T(1) }], PREGUNTAS, FORMAL).total, 1);
});

if (fallos) { console.error(`\n${fallos} fallo(s) en la lib de escaladas`); process.exit(1); }
console.log('\nTests de escaladas-audit OK');
