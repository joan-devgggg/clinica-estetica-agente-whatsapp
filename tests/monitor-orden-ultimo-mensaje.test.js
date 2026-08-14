// El Monitor ordena como WhatsApp: por el último MENSAJE, no por la última edición de la ficha.
//
// El bug (detectado el 14/08/2026, tarea 2 de la sesión): la lista del Monitor salía de
// `/api/leads`, que ordenaba por `contacts.updated_at` — y ese campo se mueve con CUALQUIER
// escritura del contacto (idioma, VIP, corregir el nombre desde el panel, resolver una
// escalada). Medido en producción: un chat cuyo último mensaje era del 7 de agosto aparecía
// 5º de 47 porque su ficha se editó el día 13, y el hilo de Carolina (mensaje del día 9)
// iba por delante de conversaciones del día 12.
//
// El arreglo: `getAllLeads` con `hasConversation` adjunta `conversations.last_message_at`
// y ordena con `ordenarPorUltimoMensaje` (puro, exportado justo para poder afirmarlo aquí
// sin Supabase). `updated_at` queda SOLO como fallback de filas sin ningún mensaje.
//
// Visto fallar sin el arreglo: con el sort por updated_at (el comportamiento anterior),
// los bloques 1 y 3 salen en rojo.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { test } = require('node:test');
const { ordenarPorUltimoMensaje } = require('../services/db');

test('una edición de ficha no sube el chat por encima de un mensaje más nuevo', () => {
    // El caso real de Mari Carmen: último mensaje del día 7, ficha editada el día 13.
    const fichaEditada = {
        nombre: 'Mari Carmen',
        last_message_at: '2026-08-07T08:57:06.274+00:00',
        updated_at: '2026-08-13T12:38:59.383+00:00',
    };
    const mensajeReciente = {
        nombre: 'Barbora',
        last_message_at: '2026-08-13T08:08:30.525+00:00',
        updated_at: '2026-08-13T08:08:30.144+00:00',
    };
    const orden = ordenarPorUltimoMensaje([fichaEditada, mensajeReciente]);
    assert.strictEqual(orden[0].nombre, 'Barbora',
        'el chat con el mensaje más reciente va primero aunque la otra ficha se haya editado después');
});

test('sin ningún mensaje, la fila cae a updated_at y no flota arriba', () => {
    const sinMensajes = { nombre: 'Recién creada', last_message_at: null, updated_at: '2026-08-10T10:00:00+00:00' };
    const conMensaje = { nombre: 'Con mensaje', last_message_at: '2026-08-12T10:00:00+00:00', updated_at: '2026-08-01T10:00:00+00:00' };
    const orden = ordenarPorUltimoMensaje([sinMensajes, conMensaje]);
    assert.strictEqual(orden[0].nombre, 'Con mensaje');
    assert.strictEqual(orden[1].nombre, 'Recién creada', 'la fila sin mensajes sigue en la lista, ordenada por su updated_at');
});

test('el orden es el del mensaje, de más nuevo a más viejo', () => {
    // Tres chats reales de la ventana del 11-13/08, desordenados a propósito.
    const leads = [
        { nombre: 'Daria',   last_message_at: '2026-08-12T10:49:22+00:00', updated_at: '2026-08-12T10:49:20+00:00' },
        { nombre: 'Anna',    last_message_at: '2026-08-13T12:50:19+00:00', updated_at: '2026-08-13T12:50:18+00:00' },
        { nombre: 'Mariola', last_message_at: '2026-08-12T16:42:13+00:00', updated_at: '2026-08-13T20:00:00+00:00' }, // ficha tocada después
    ];
    const orden = ordenarPorUltimoMensaje(leads).map(l => l.nombre);
    assert.deepStrictEqual(orden, ['Anna', 'Mariola', 'Daria']);
});

// Este bloque NO mide la clave de orden (pasa con updated_at y con last_message_at):
// mide que la función es PURA. Saboteado el 14/08/2026 quitando el spread
// ([...leads] → leads, sort in-place): falla SOLO este bloque; con la clave equivocada
// fallan los tres de arriba y este no. Protege que un refactor no convierta a
// getAllLeads en mutador de la lista que le pasen.
test('no muta la lista que recibe', () => {
    const leads = [
        { nombre: 'B', last_message_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
        { nombre: 'A', last_message_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-02T00:00:00Z' },
    ];
    ordenarPorUltimoMensaje(leads);
    assert.strictEqual(leads[0].nombre, 'B', 'el array original queda como estaba');
});
