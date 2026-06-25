const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'clients.db');
const LEGACY_JSON = path.join(DATA_DIR, 'clients.json');
const MAX_HISTORY_LOADED = 40;

// --- Init ---

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    phone        TEXT PRIMARY KEY,
    partialData  TEXT NOT NULL DEFAULT '{}',
    history      TEXT NOT NULL DEFAULT '[]',
    summary      TEXT,
    leadGuardado INTEGER NOT NULL DEFAULT 0,
    leadStatus   TEXT NOT NULL DEFAULT 'in_progress',
    botActivo    INTEGER NOT NULL DEFAULT 1,
    messageCount INTEGER NOT NULL DEFAULT 0,
    variant      TEXT,
    firstSeen    INTEGER NOT NULL,
    lastSeen     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY);
`);

try {
  db.exec(`ALTER TABLE clients ADD COLUMN summary TEXT`);
} catch (_) { /* column already exists */ }

// Estado específico del salón (Sante) que no cabe en partialData: servicio/estilista
// seleccionados, idioma, upselling, etc. Se persiste para sobrevivir a reinicios de
// PM2 o timeouts de sesión a mitad de flujo (si no, al aceptar el hueco no hay servicio
// que resolver y la cita no se guarda). Los huecos NO se persisten: se recalculan.
try {
  db.exec(`ALTER TABLE clients ADD COLUMN extra TEXT`);
} catch (_) { /* column already exists */ }

const stmtGet    = db.prepare('SELECT * FROM clients WHERE phone = ?');
const stmtUpsert = db.prepare(`
  INSERT INTO clients
    (phone, partialData, history, summary, extra, leadGuardado, leadStatus, botActivo, messageCount, variant, firstSeen, lastSeen)
  VALUES
    (@phone, @partialData, @history, @summary, @extra, @leadGuardado, @leadStatus, @botActivo, @messageCount, @variant, @firstSeen, @lastSeen)
  ON CONFLICT(phone) DO UPDATE SET
    partialData  = excluded.partialData,
    history      = excluded.history,
    summary      = COALESCE(excluded.summary, clients.summary),
    extra        = excluded.extra,
    leadGuardado = excluded.leadGuardado,
    leadStatus   = excluded.leadStatus,
    botActivo    = excluded.botActivo,
    messageCount = excluded.messageCount,
    variant      = excluded.variant,
    lastSeen     = excluded.lastSeen
`);
const stmtSaveSummary = db.prepare('UPDATE clients SET summary = ? WHERE phone = ?');
const stmtDelete  = db.prepare('DELETE FROM clients WHERE phone = ?');
const stmtExists = db.prepare('SELECT 1 FROM clients WHERE phone = ? LIMIT 1');
const stmtCount  = db.prepare('SELECT COUNT(*) as n FROM clients');

// --- Migration from legacy JSON ---

function migrateFromJSON() {
  if (!fs.existsSync(LEGACY_JSON)) return;

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
  } catch {
    return;
  }

  const insert = db.transaction((entries) => {
    for (const [phone, entry] of entries) {
      const existing = stmtGet.get(phone);
      if (existing) continue;

      stmtUpsert.run({
        phone,
        partialData:  JSON.stringify(entry.partialData || { telefono: phone }),
        history:      JSON.stringify(entry.history || []),
        summary:      entry.summary || null,
        extra:        entry.extra ? JSON.stringify(entry.extra) : null,
        leadGuardado: entry.leadGuardado ? 1 : 0,
        leadStatus:   entry.leadStatus || 'in_progress',
        botActivo:    entry.botActivo !== false ? 1 : 0,
        messageCount: entry.messageCount || 0,
        variant:      entry.variant || null,
        firstSeen:    entry.firstSeen || Date.now(),
        lastSeen:     entry.lastSeen  || Date.now(),
      });
    }
  });

  const entries = Object.entries(legacy);
  if (entries.length === 0) return;

  insert(entries);
  console.log(`📦 Migración completada: ${entries.length} clientes importados desde JSON`);

  try {
    fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrated');
  } catch (_) {}
}

migrateFromJSON();

console.log(`📂 Base de datos SQLite lista: ${clientCount()} clientes`);

// --- Public API ---
// orgId prefix in the key ensures the same phone talking to two orgs gets separate sessions.

function makeKey(orgId, phone) {
  const digits = phone.replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '');
  return orgId ? `${orgId}:${digits}` : digits;
}

function loadClient(orgId, phone) {
  const key = makeKey(orgId, phone);
  let row = stmtGet.get(key);

  // Fallback: try legacy key (no orgId prefix) for backward compat
  if (!row && orgId) {
    const legacyKey = phone.replace(/@c\.us$|@lid$/g, '').replace(/\D/g, '');
    row = stmtGet.get(legacyKey);
  }

  if (!row) return null;

  const fullHistory = JSON.parse(row.history);
  const totalMessages = fullHistory.length;

  console.log(`🧠 Cliente conocido: ${key} | mensajes totales: ${totalMessages} | último: ${new Date(row.lastSeen).toLocaleString()}`);

  let extra = null;
  if (row.extra) { try { extra = JSON.parse(row.extra); } catch { extra = null; } }

  return {
    partialData:   JSON.parse(row.partialData),
    history:       fullHistory.slice(-MAX_HISTORY_LOADED),
    summary:       row.summary || null,
    extra,
    leadGuardado:  row.leadGuardado === 1,
    leadStatus:    row.leadStatus,
    botActivo:     row.botActivo === 1,
    messageCount:  row.messageCount,
    variant:       row.variant || null,
    firstSeen:     row.firstSeen,
    lastSeen:      row.lastSeen,
    totalMessages,
  };
}

function saveClient(orgId, phone, session) {
  const key = makeKey(orgId, phone);
  const existing = stmtGet.get(key);

  let mergedHistory = session.history || [];
  if (existing) {
    const storedHistory = JSON.parse(existing.history);
    if (storedHistory.length > mergedHistory.length) {
      const oldPart = storedHistory.slice(0, storedHistory.length - MAX_HISTORY_LOADED);
      mergedHistory = [...oldPart, ...mergedHistory];
    }
  }

  stmtUpsert.run({
    phone:        key,
    partialData:  JSON.stringify(session.partialData || {}),
    history:      JSON.stringify(mergedHistory),
    summary:      session.summary || null,
    extra:        session.extra ? JSON.stringify(session.extra) : null,
    leadGuardado: session.leadGuardado ? 1 : 0,
    leadStatus:   session.leadStatus   || 'in_progress',
    botActivo:    session.botActivo !== false ? 1 : 0,
    messageCount: session.messageCount || 0,
    variant:      session.variant      || null,
    firstSeen:    existing?.firstSeen  || Date.now(),
    lastSeen:     Date.now(),
  });
}

function saveSummary(orgId, phone, summary) {
  stmtSaveSummary.run(summary, makeKey(orgId, phone));
}

function isReturningClient(orgId, phone) {
  return Boolean(stmtExists.get(makeKey(orgId, phone)));
}

function deleteClient(orgId, phone) {
  stmtDelete.run(makeKey(orgId, phone));
}

function clientCount() {
  return stmtCount.get().n;
}

module.exports = { loadClient, saveClient, saveSummary, isReturningClient, clientCount, deleteClient };
