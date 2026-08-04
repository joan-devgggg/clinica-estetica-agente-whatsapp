/**
 * nombres-audit.js — ¿A quién no sabemos cómo llamar?
 *
 * El nombre de una clienta vive en dos columnas que no se copian entre sí:
 *
 *   · `contacts.full_name` — NULLABLE. La leen el bot (para saludar) y el worker de
 *     recordatorios. Sin ella, el recordatorio de 24 h NO sale: motivoNoEnviable devuelve
 *     'sin_nombre', se avisa por Telegram y la cita se queda sin aviso.
 *   · `appointments.full_name` — NOT NULL. Cuando el contacto no tiene nombre,
 *     saveAppointment escribe cadena VACÍA, no null. Ningún `IS NULL` la encuentra, y es la
 *     que el panel enseña como "próxima cita" de nadie.
 *
 * Por eso se miran las dos y se cruzan: el caso más común no es "no sabemos su nombre" sino
 * "lo sabemos, pero está en la otra columna" — y eso se arregla copiándolo, sin molestar a
 * la clienta.
 *
 * "Sin nombre" no es `!full_name`: es `!isUsableName(full_name)` (services/helpers.js), la
 * definición ÚNICA en el repo de "¿esto sirve para poner después de Hola?". Así entran
 * también los rellenos ('cliente', '-', 'null') que sí ocupan la columna pero con los que
 * no se puede saludar a nadie, y NO salen los nombres cirílicos o con guiones, que son
 * perfectamente válidos.
 *
 * Función PURA: recibe filas ya leídas y devuelve hallazgos. Sin `db`, sin red. Los tests
 * herméticos la ejercen con fixtures (tests/nombres-audit.test.js) y el informe
 * `npm run informe:nombres` con Supabase real.
 */

const { isUsableName } = require('../../services/helpers');

// 'error' → algo que ya está roto y tiene fecha: hay una cita futura y el recordatorio no
//           va a salir, o va a salir mal.
// 'aviso' → hueco de datos real, sin nada pendiente que se estropee hoy.
const SEVERIDAD = {
    'cita-futura-sin-nombre': 'error',
    'contacto-sin-nombre-con-cita': 'error',
    'cita-pasada-sin-nombre': 'aviso',
    'contacto-sin-nombre': 'aviso',
};

/** El nombre que hay guardado, tal cual, para poder enseñarlo en el informe. */
function comoSeGuardo(valor) {
    if (valor === null || valor === undefined) return '(null)';
    if (String(valor).trim() === '') return '(cadena vacía)';
    return `"${valor}"`;
}

/**
 * @param {object} input
 * @param {Array}  input.contactos  { id, wa_phone, full_name, estado, visit_count, is_blacklisted, created_at }
 * @param {Array}  input.citas      { id, contact_id, full_name, phone, service, starts_at, status }
 * @param {Date}   input.ahora      Referencia para "futura" vs "pasada". Explícita a propósito.
 * @returns {{hallazgos: Array, resumen: object}}
 */
function auditNombres({ contactos = [], citas = [], ahora = new Date() } = {}) {
    const hallazgos = [];

    const contactoPorId = new Map(contactos.map(c => [c.id, c]));
    const citasPorContacto = new Map();
    for (const cita of citas) {
        if (!cita.contact_id) continue;
        if (!citasPorContacto.has(cita.contact_id)) citasPorContacto.set(cita.contact_id, []);
        citasPorContacto.get(cita.contact_id).push(cita);
    }

    const esFutura = (cita) => {
        const t = new Date(cita.starts_at).getTime();
        return Number.isFinite(t) && t >= ahora.getTime();
    };

    // ── Columna 1: contacts.full_name ────────────────────────────────────────
    for (const contacto of contactos) {
        if (isUsableName(contacto.full_name)) continue;

        const suyas = citasPorContacto.get(contacto.id) || [];
        const futuras = suyas.filter(esFutura);
        // ¿Está el nombre en la otra columna? Entonces esto se rellena solo, sin preguntar.
        const desdeCita = suyas.map(c => c.full_name).find(isUsableName) || null;

        const tipo = futuras.length ? 'contacto-sin-nombre-con-cita' : 'contacto-sin-nombre';
        hallazgos.push({
            tipo,
            severidad: SEVERIDAD[tipo],
            columna: 'contacts.full_name',
            contacto_id: contacto.id,
            telefono: contacto.wa_phone || null,
            guardado: comoSeGuardo(contacto.full_name),
            citas_futuras: futuras.length,
            proxima_cita: futuras.length ? futuras[0].starts_at : null,
            rellenable_con: desdeCita,
            detalle: futuras.length
                ? `Tiene ${futuras.length} cita(s) futura(s) y el recordatorio de 24 h no saldrá: sin nombre se bloquea el envío.`
                : 'El bot no puede saludarla por su nombre.',
        });
    }

    // ── Columna 2: appointments.full_name (NOT NULL → llega vacía) ───────────
    for (const cita of citas) {
        if (isUsableName(cita.full_name)) continue;

        const contacto = cita.contact_id ? contactoPorId.get(cita.contact_id) : null;
        const desdeContacto = isUsableName(contacto?.full_name) ? contacto.full_name : null;
        const futura = esFutura(cita);
        const tipo = futura ? 'cita-futura-sin-nombre' : 'cita-pasada-sin-nombre';

        hallazgos.push({
            tipo,
            severidad: SEVERIDAD[tipo],
            columna: 'appointments.full_name',
            cita_id: cita.id,
            contacto_id: cita.contact_id || null,
            telefono: cita.phone || contacto?.wa_phone || null,
            guardado: comoSeGuardo(cita.full_name),
            starts_at: cita.starts_at,
            servicio: cita.service,
            estado: cita.status,
            rellenable_con: desdeContacto,
            detalle: desdeContacto
                ? 'El contacto SÍ tiene nombre: la fila de la cita se quedó con la cadena vacía que escribió saveAppointment.'
                : 'Ni la cita ni el contacto tienen nombre utilizable.',
        });
    }

    // Los errores primero y, dentro, lo más inminente antes: el informe se lee de arriba
    // abajo y quien lo lee tiene un rato, no una tarde.
    const orden = { error: 0, aviso: 1 };
    hallazgos.sort((a, b) => {
        if (orden[a.severidad] !== orden[b.severidad]) return orden[a.severidad] - orden[b.severidad];
        const fa = a.proxima_cita || a.starts_at || '';
        const fb = b.proxima_cita || b.starts_at || '';
        return String(fa).localeCompare(String(fb));
    });

    const resumen = {
        contactos_totales: contactos.length,
        citas_totales: citas.length,
        contactos_sin_nombre: hallazgos.filter(h => h.columna === 'contacts.full_name').length,
        citas_sin_nombre: hallazgos.filter(h => h.columna === 'appointments.full_name').length,
        errores: hallazgos.filter(h => h.severidad === 'error').length,
        avisos: hallazgos.filter(h => h.severidad === 'aviso').length,
        // Cuántos se arreglan copiando de la otra columna, sin preguntarle nada a nadie.
        rellenables: hallazgos.filter(h => h.rellenable_con).length,
    };

    return { hallazgos, resumen };
}

module.exports = { auditNombres, SEVERIDAD, comoSeGuardo };
