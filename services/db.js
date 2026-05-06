/**
 * db.js — SQLite storage (reemplaza Airtable)
 * Misma interfaz pública que airtable.js para compatibilidad con bot, review y reminder.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'clinica.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Esquema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre                TEXT,
    telefono              TEXT,
    tratamiento           TEXT,
    preferencia_horaria   TEXT,
    fecha_cita            TEXT,
    hora_cita             TEXT,
    estado_cita           TEXT DEFAULT 'pendiente',
    resena_enviada        INTEGER DEFAULT 0,
    recordatorio_enviado  INTEGER DEFAULT 0,
    origen                TEXT DEFAULT 'instagram_ads',
    notas                 TEXT,
    appointment_id        TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    clave       TEXT PRIMARY KEY,
    valor       TEXT,
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Helpers internos ─────────────────────────────────────────────────────────

function sanitizePhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    return phone.replace(/["'\s]/g, '').trim();
}

function now() { return new Date().toISOString(); }

function rowToPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        nombre: row.nombre,
        telefono: row.telefono,
        tratamiento: row.tratamiento,
        preferencia_horaria: row.preferencia_horaria,
        fecha_cita: row.fecha_cita,
        hora_cita: row.hora_cita,
        estado_cita: row.estado_cita || 'pendiente',
        resena_enviada: !!row.resena_enviada,
        recordatorio_enviado: !!row.recordatorio_enviado,
        origen: row.origen,
        notas: row.notas,
        appointment_id: row.appointment_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// ─── Leads ────────────────────────────────────────────────────────────────────

function findByPhone(telefono) {
    const phone = sanitizePhone(telefono);
    if (!phone) return null;
    const row = db.prepare('SELECT * FROM leads WHERE telefono = ? ORDER BY id DESC LIMIT 1').get(phone);
    return rowToPublic(row);
}

function findById(id) {
    const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    return rowToPublic(row);
}

function getAllLeads({ limit = 200, offset = 0, estado, search } = {}) {
    let sql = 'SELECT * FROM leads WHERE 1=1';
    const params = [];
    if (estado) { sql += ' AND estado_cita = ?'; params.push(estado); }
    if (search) {
        sql += ' AND (nombre LIKE ? OR telefono LIKE ? OR tratamiento LIKE ?)';
        const q = `%${search}%`;
        params.push(q, q, q);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return db.prepare(sql).all(...params).map(rowToPublic);
}

function getLeadsByDateRange(desde, hasta) {
    return db.prepare(
        `SELECT * FROM leads
         WHERE fecha_cita IS NOT NULL AND fecha_cita != ''
           AND fecha_cita BETWEEN ? AND ?
           AND estado_cita NOT IN ('cancelado')
         ORDER BY fecha_cita ASC, hora_cita ASC`
    ).all(desde, hasta).map(rowToPublic);
}

function guardarLeadEnAirtable(datos) {
    if (!datos.telefono) return null;
    const phone = sanitizePhone(datos.telefono);

    // Si ya tenemos recordId en sesión, actualizamos esa fila
    if (datos.airtableRecordId) {
        return updateLeadInAirtable(datos);
    }

    // Siempre crear fila nueva para cada conversación
    const stmt = db.prepare(`
        INSERT INTO leads (nombre, telefono, tratamiento, preferencia_horaria,
                           fecha_cita, hora_cita, estado_cita, origen, notas, appointment_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const pref = datos.preferencia_horaria
        ? (typeof datos.preferencia_horaria === 'object'
            ? datos.preferencia_horaria.periodo || JSON.stringify(datos.preferencia_horaria)
            : datos.preferencia_horaria)
        : null;

    const result = stmt.run(
        datos.nombre || null,
        phone,
        datos.tratamiento || null,
        pref,
        datos.fecha_cita || null,
        datos.hora_cita || null,
        datos.estado_cita || 'pendiente',
        datos.origen || 'instagram_ads',
        datos.notas || null,
        datos.appointment_id || null,
        now()
    );
    return result.lastInsertRowid;
}

function updateLeadInAirtable(datos) {
    if (!datos.telefono && !datos.airtableRecordId) return false;

    const phone = sanitizePhone(datos.telefono);
    let row = datos.airtableRecordId
        ? db.prepare('SELECT id FROM leads WHERE id = ?').get(datos.airtableRecordId)
        : db.prepare('SELECT id FROM leads WHERE telefono = ? ORDER BY id DESC LIMIT 1').get(phone);

    if (!row) return !!guardarLeadEnAirtable(datos);

    const pref = datos.preferencia_horaria
        ? (typeof datos.preferencia_horaria === 'object'
            ? datos.preferencia_horaria.periodo || JSON.stringify(datos.preferencia_horaria)
            : datos.preferencia_horaria)
        : undefined;

    const updates = {};
    if (datos.nombre !== undefined)       updates.nombre = datos.nombre;
    if (datos.telefono !== undefined)     updates.telefono = phone;
    if (datos.tratamiento !== undefined)  updates.tratamiento = datos.tratamiento;
    if (pref !== undefined)               updates.preferencia_horaria = pref;
    if (datos.fecha_cita !== undefined)   updates.fecha_cita = datos.fecha_cita;
    if (datos.hora_cita !== undefined)    updates.hora_cita = datos.hora_cita;
    if (datos.estado_cita !== undefined)  updates.estado_cita = datos.estado_cita;
    if (datos.notas !== undefined)        updates.notas = datos.notas;
    if (datos.appointment_id !== undefined) updates.appointment_id = datos.appointment_id;
    updates.updated_at = now();

    const keys = Object.keys(updates);
    if (keys.length === 1) return true; // solo updated_at
    const set = keys.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE leads SET ${set} WHERE id = ?`).run(...Object.values(updates), row.id);
    return true;
}

function updateLeadById(id, campos) {
    const allowed = ['nombre', 'telefono', 'tratamiento', 'preferencia_horaria',
                     'fecha_cita', 'hora_cita', 'estado_cita', 'notas', 'origen'];
    const updates = {};
    for (const k of allowed) {
        if (campos[k] !== undefined) updates[k] = campos[k];
    }
    updates.updated_at = now();
    const keys = Object.keys(updates);
    const set = keys.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE leads SET ${set} WHERE id = ?`).run(...Object.values(updates), id);
    return findById(id);
}

function deleteLead(id) {
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
}

function marcarCitaCompletada(telefono) {
    const phone = sanitizePhone(telefono);
    db.prepare(`UPDATE leads SET estado_cita = 'completado', updated_at = ? WHERE telefono = ?`).run(now(), phone);
    return true;
}

function marcarResenaSent(id) {
    db.prepare(`UPDATE leads SET resena_enviada = 1, updated_at = ? WHERE id = ?`).run(now(), id);
    return true;
}

function marcarRecordatorioSent(id) {
    db.prepare(`UPDATE leads SET recordatorio_enviado = 1, updated_at = ? WHERE id = ?`).run(now(), id);
    return true;
}

function getLeadsPendientesResena() {
    return db.prepare(`
        SELECT * FROM leads
        WHERE estado_cita = 'completado' AND resena_enviada = 0
    `).all().map(rowToPublic);
}

function getLeadsPendientesRecordatorio() {
    return db.prepare(`
        SELECT * FROM leads
        WHERE estado_cita = 'confirmado' AND recordatorio_enviado = 0
          AND fecha_cita IS NOT NULL
    `).all().map(rowToPublic);
}

// ─── Config ───────────────────────────────────────────────────────────────────

function getConfigValue(clave) {
    const row = db.prepare('SELECT valor FROM config WHERE clave = ?').get(clave);
    if (!row) return null;
    try { return JSON.parse(row.valor); } catch { return row.valor; }
}

function setConfigValue(clave, valor) {
    const valorStr = typeof valor === 'string' ? valor : JSON.stringify(valor);
    db.prepare(`
        INSERT INTO config (clave, valor, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at
    `).run(clave, valorStr, now());
    return true;
}

function getAllConfig() {
    const rows = db.prepare('SELECT clave, valor FROM config').all();
    const result = {};
    for (const row of rows) {
        try { result[row.clave] = JSON.parse(row.valor); } catch { result[row.clave] = row.valor; }
    }
    return result;
}

// ─── Stats dashboard ──────────────────────────────────────────────────────────

function getStats() {
    const total = db.prepare(`SELECT COUNT(*) as n FROM leads`).get().n;
    const confirmados = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE estado_cita = 'confirmado'`).get().n;
    const enChat = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE estado_cita IN ('pendiente','en_conversacion')`).get().n;
    const completados = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE estado_cita = 'completado'`).get().n;
    const hoy = new Date().toISOString().split('T')[0];
    const citasHoy = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE fecha_cita = ? AND estado_cita = 'confirmado'`).get(hoy).n;
    const manana = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const citasManana = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE fecha_cita = ? AND estado_cita = 'confirmado'`).get(manana).n;
    return { total, confirmados, enChat, completados, citasHoy, citasManana };
}

module.exports = {
    // Compatibilidad con airtable.js (bot, review, reminder)
    guardarLeadEnAirtable,
    updateLeadInAirtable,
    findByPhone,
    marcarCitaCompletada,
    marcarResenaSent,
    marcarRecordatorioSent,
    getLeadsPendientesResena,
    getLeadsPendientesRecordatorio,
    getConfigValue,
    setConfigValue,
    // API dashboard
    getAllLeads,
    getLeadsByDateRange,
    findById,
    updateLeadById,
    deleteLead,
    getAllConfig,
    getStats,
    // Acceso directo a la instancia (para migraciones puntuales)
    _db: db,
};
