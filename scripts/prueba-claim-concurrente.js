#!/usr/bin/env node
/**
 * prueba-claim-concurrente.js — la prueba de verdad de la migración 043.
 *
 * N reservas SIMULTÁNEAS sobre el MISMO hueco → gana exactamente 1 y las demás reciben
 * `hueco_ocupado`. Y como un test que pasa con y sin el arreglo no protege nada (regla 2),
 * la misma corrida EJECUTA las dos mutaciones y exige verlas fallar:
 *
 *   FASE 1 · normal      1 ganadora, N−1 `hueco_ocupado`, 1 fila en la tabla.
 *   FASE 2 · mutación A  sin EXCLUDE + sin cerrojo (+ pg_sleep que mantiene abierta la
 *                        ventana del check-then-insert): tienen que ganar ≥2 — la
 *                        catástrofe que la 043 impide. Si aquí gana 1, la prueba no
 *                        demuestra nada y sale en rojo POR ESO.
 *   FASE 3 · mutación B  con EXCLUDE + sin cerrojo (+ sin el handler de 23P01): tiene que
 *                        quedar EXACTAMENTE 1 fila (el EXCLUDE es la garantía de verdad) y
 *                        las perdedoras tienen que reventar CRUDO — 23P01 o 40P01, el modo
 *                        varía entre corridas — que es lo que el cerrojo y el handler
 *                        convierten en motivo limpio.
 *   FASE 4 · web sobre cita MANUAL — la ruta que el EXCLUDE NO cubre por diseño (su
 *                        predicado deja `manual` fuera) y que es el choque más probable:
 *                        57 de 58 citas reales son manuales. Tres piezas:
 *                        4a  con una manual solapando, reservar_hueco() devuelve
 *                            hueco_ocupado en las CINCO geometrías de solape, y el control
 *                            adyacente (sin solape) SÍ escribe — se mide solape, no cercanía.
 *                        4b  la mutación en rojo: la función real MENOS el paso 6 (cirugía
 *                            sobre pg_get_functiondef, verificada) escribe ENCIMA de la
 *                            manual con cero 23P01 — el paso 6 es la ÚNICA protección aquí.
 *                        4c  el residuo declarado en la 043, demostrado (ventana abierta con
 *                            pg_sleep: una manual que comitea dentro produce el solape) y
 *                            MEDIDO (reservar_hueco_medida, 40 iteraciones: la ventana
 *                            interna check→INSERT y la llamada entera como cota superior).
 *
 * Entre fases se restaura el estado original (la función se captura con
 * pg_get_functiondef antes de tocar nada) y al final se comprueba que quedó restaurado.
 *
 * ── CONTRA QUÉ CORRE ─────────────────────────────────────────────────────────────────────
 *
 * NUNCA contra producción. El destino se pasa EXPLÍCITO:
 *
 *   PRUEBA_DB_URL='postgres://…' node scripts/prueba-claim-concurrente.js
 *
 * Tres guardas, todas duras:
 *   1. Sin PRUEBA_DB_URL no corre. No hay default: un default aquí sería producción.
 *   2. Si el host de PRUEBA_DB_URL contiene el ref del proyecto de PRODUCCIÓN (leído en
 *      vivo del SUPABASE_URL de .env, no de una constante), aborta. Una rama de Supabase
 *      tiene su propio project_ref, así que la guarda no molesta al caso legítimo.
 *   3. Si `appointments` tiene filas de CUALQUIER org distinta de la sembrada, aborta:
 *      eso no es una base desechable.
 *
 * `--bootstrap-esquema`: para un Postgres vacío (docker desechable), crea el MÍNIMO de
 * tablas que la función toca y aplica la 043 desde su fichero. Solo si `appointments` NO
 * existe. Es una copia mínima del esquema para una BD que se tira al terminar — el esquema
 * de verdad sigue siendo el de las migraciones.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const N = 12;            // reservas simultáneas por fase
const ORG = '00000000-0000-4000-8000-0000000c0430'; // uuid propio de la prueba, reconocible
const STYLIST = '00000000-0000-4000-8000-0000000c0431';

const MIGRACION_043 = path.join(__dirname, '..', 'supabase', 'migrations', '043_reserva_web_claim.sql');

let fallos = 0;
function ok(cond, msg, extra) {
    if (cond) { console.log(`ok - ${msg}`); return; }
    fallos++;
    console.error(`fail - ${msg}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
}

// ── Guardas de destino ───────────────────────────────────────────────────────────────────

function resolverDestino() {
    const url = process.env.PRUEBA_DB_URL;
    if (!url) {
        console.error('fail - PRUEBA_DB_URL no está puesta. Esta prueba ESCRIBE y MUTA el esquema:');
        console.error('       solo corre contra una rama de Supabase o un Postgres desechable, nunca');
        console.error('       contra producción, y por eso el destino no tiene default.');
        process.exit(1);
    }
    // El ref de producción se lee EN VIVO de .env — una constante escrita aquí caducaría
    // en la primera migración de proyecto y dejaría la guarda mirando al sitio equivocado.
    try {
        const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
        const m = env.match(/^SUPABASE_URL\s*=\s*https?:\/\/([a-z0-9]+)\.supabase\.co/m);
        if (m && url.includes(m[1])) {
            console.error(`fail - PRUEBA_DB_URL apunta al proyecto de PRODUCCIÓN (${m[1]}). Abortado.`);
            process.exit(1);
        }
    } catch { /* sin .env legible no hay ref que comparar; quedan las otras dos guardas */ }
    return url;
}

// ── Bootstrap para un Postgres vacío (solo docker desechable) ───────────────────────────

const ESQUEMA_MINIMO = `
CREATE TABLE organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL
);
CREATE TABLE stylists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    role text NOT NULL
);
CREATE TABLE contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    wa_phone text NOT NULL
);
CREATE TABLE stylist_schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    stylist_id uuid NOT NULL REFERENCES stylists(id) ON DELETE CASCADE,
    day_of_week integer NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL
);
CREATE TABLE schedule_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    stylist_id uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    reason text
);
CREATE TABLE blocked_days (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    stylist_id uuid,
    fecha date NOT NULL,
    motivo text NOT NULL DEFAULT 'otro'
);
CREATE TABLE appointments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    service text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    status text DEFAULT 'confirmed',
    full_name text NOT NULL,
    phone text NOT NULL,
    notes text,
    recordatorio_enviado boolean DEFAULT false,
    stylist_id uuid REFERENCES stylists(id) ON DELETE SET NULL,
    source text DEFAULT 'bot',
    updated_by text,
    created_at timestamptz DEFAULT now()
);`;

async function bootstrapSiHaceFalta(pool) {
    const { rows } = await pool.query(`SELECT to_regclass('public.appointments') IS NOT NULL AS existe`);
    if (rows[0].existe) return false;
    if (!process.argv.includes('--bootstrap-esquema')) {
        console.error('fail - la BD destino no tiene `appointments`. Si es un Postgres desechable,');
        console.error('       vuelve a lanzar con --bootstrap-esquema; si es una rama, sus migraciones');
        console.error('       no se han aplicado y eso hay que mirarlo, no taparlo aquí.');
        process.exit(1);
    }
    await pool.query(ESQUEMA_MINIMO);
    // La 043 se aplica DESDE SU FICHERO, no desde una copia pegada aquí: si el fichero
    // cambia, la prueba prueba lo nuevo. Los GRANT/REVOKE de roles de Supabase no existen
    // en un Postgres pelado y se omiten (aquí no hay `anon` del que protegerse).
    let sql = fs.readFileSync(MIGRACION_043, 'utf8');
    sql = sql.split('\n').filter(l => !/^\s*(REVOKE|GRANT)\s/i.test(l)).join('\n');
    await pool.query(sql);
    console.log('ok - esquema mínimo + 043 aplicados sobre BD vacía (--bootstrap-esquema)');
    return true;
}

// ── Siembra ──────────────────────────────────────────────────────────────────────────────

async function sembrar(pool) {
    // Guarda 3: una BD con citas de otra org NO es desechable.
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM appointments WHERE organization_id <> $1`, [ORG]);
    if (rows[0].n > 0) {
        console.error(`fail - la BD destino tiene ${rows[0].n} citas de otras orgs. Esto no es una`);
        console.error('       base desechable. Abortado sin escribir nada.');
        process.exit(1);
    }
    // Idempotente: la org de la prueba se limpia y se resiembra entera.
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Prueba claim 043', 'prueba-claim-043')`, [ORG]);
    await pool.query(`INSERT INTO stylists (id, organization_id, name, role) VALUES ($1, $2, 'Estilista Prueba', 'test')`, [STYLIST, ORG]);
    // Horario 10:00–19:00 los 7 días: la fecha del hueco no depende del día que corra la prueba.
    for (let d = 0; d <= 6; d++) {
        await pool.query(
            `INSERT INTO stylist_schedules (organization_id, stylist_id, day_of_week, start_time, end_time)
             VALUES ($1, $2, $3, '10:00', '19:00')`, [ORG, STYLIST, d]);
    }
    const contactos = [];
    for (let i = 0; i < N + 4; i++) {
        const { rows: r } = await pool.query(
            `INSERT INTO contacts (organization_id, wa_phone) VALUES ($1, $2) RETURNING id`,
            [ORG, `34600${String(100000 + i)}`]);
        contactos.push(r[0].id);
    }
    // El hueco: mañana (fecha UTC +1, siempre futura en Madrid) a las 12:00 de PARED Madrid.
    const { rows: slot } = await pool.query(
        `SELECT ((current_date + 1) + time '12:00') AT TIME ZONE 'Europe/Madrid' AS ini,
                ((current_date + 1) + time '13:00') AT TIME ZONE 'Europe/Madrid' AS fin,
                (current_date + 1) AS fecha`);
    return { contactos, ini: slot[0].ini, fin: slot[0].fin, fecha: slot[0].fecha };
}

// ── Las tres formas de disparar ──────────────────────────────────────────────────────────

function llamada(pool, contactId, s) {
    return pool.query(
        `SELECT * FROM reservar_hueco($1,$2,$3,$4,$5,'Servicio Prueba','Clienta Prueba','34600000000',NULL,2)`,
        [ORG, contactId, STYLIST, s.ini, s.fin]
    ).then(r => ({ tipo: 'fila', ...r.rows[0] }))
     .catch(e => ({ tipo: 'excepcion', code: e.code || null, message: e.message }));
}

async function andanada(pool, contactos, s) {
    const res = await Promise.all(contactos.slice(0, N).map(c => llamada(pool, c, s)));
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM appointments
          WHERE organization_id = $1 AND stylist_id = $2 AND starts_at = $3
            AND status IS DISTINCT FROM 'cancelled'`, [ORG, STYLIST, s.ini]);
    return {
        ganadoras:  res.filter(r => r.tipo === 'fila' && r.ok === true).length,
        ocupado:    res.filter(r => r.tipo === 'fila' && r.motivo === 'hueco_ocupado').length,
        crudas23P01: res.filter(r => r.tipo === 'excepcion' && r.code === '23P01').length,
        otrasExcepciones: res.filter(r => r.tipo === 'excepcion' && r.code !== '23P01'),
        filas: rows[0].n,
    };
}

async function limpiarHueco(pool, s) {
    await pool.query(
        `DELETE FROM appointments WHERE organization_id = $1 AND stylist_id = $2 AND starts_at = $3`,
        [ORG, STYLIST, s.ini]);
}

// ── Mutaciones: la función SIN cerrojo y SIN handler, con la ventana abierta a propósito ──
//
// pg_sleep(0.25) entre el check y el INSERT no es trampa: es el reloj parado en el hueco
// TOCTOU que en producción dura microsegundos. Sin él, la mutación A fallaría "a veces",
// y una prueba que falla a veces no demuestra nada.
const FUNCION_SIN_CERROJO = `
CREATE OR REPLACE FUNCTION reservar_hueco(
    p_org uuid, p_contact uuid, p_stylist uuid,
    p_starts_at timestamptz, p_ends_at timestamptz,
    p_servicio text, p_full_name text, p_phone text,
    p_notas text DEFAULT NULL, p_max_futuras integer DEFAULT 2
)
RETURNS TABLE (ok boolean, motivo text, cita_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $mut$
DECLARE v_id uuid;
BEGIN
    IF EXISTS (
        SELECT 1 FROM appointments
         WHERE organization_id = p_org AND stylist_id = p_stylist
           AND status IS DISTINCT FROM 'cancelled'
           AND tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)
    ) THEN
        RETURN QUERY SELECT false, 'hueco_ocupado', NULL::uuid; RETURN;
    END IF;
    PERFORM pg_sleep(0.25);  -- la ventana TOCTOU, mantenida abierta
    INSERT INTO appointments (organization_id, contact_id, stylist_id, service,
        starts_at, ends_at, status, source, updated_by, full_name, phone, notes, recordatorio_enviado)
    VALUES (p_org, p_contact, p_stylist, p_servicio, p_starts_at, p_ends_at,
        'confirmed', 'web', 'web', p_full_name, p_phone, p_notas, false)
    RETURNING id INTO v_id;
    RETURN QUERY SELECT true, 'ok', v_id;
END;
$mut$;`;

// ── Fase 4: cirugía sobre la función REAL, no mutantes escritos a mano ───────────────────
//
// Las mutaciones de la fase 4 se derivan de la definición capturada con pg_get_functiondef
// (que conserva el cuerpo con sus comentarios, prosrc verbatim), cortando o insertando en
// los marcadores `-- (6)` / `-- (7)`. Así lo mutado es la función de verdad menos la pieza,
// no una copia paralela que podría divergir de ella. Si el marcador no está, la cirugía
// devuelve null y la prueba FALLA con eso en pantalla — nunca muta otra cosa en silencio.

function sinPaso6(src) {
    const a = src.indexOf('-- (6)');
    const b = src.indexOf('-- (7)');
    if (a === -1 || b === -1 || b <= a) return null;
    return src.slice(0, a) + src.slice(b);
}

function conVentanaAbierta(src) {
    const b = src.indexOf('-- (7)');
    if (b === -1) return null;
    return src.slice(0, b)
        + 'PERFORM pg_sleep(0.25);  -- VENTANA ABIERTA: solo mutación de prueba (residuo 4c)\n    '
        + src.slice(b);
}

// Como `llamada`, pero con el rango explícito — la fase 4 prueba cinco geometrías de solape.
function llamadaRango(pool, contactId, ini, fin) {
    return pool.query(
        `SELECT * FROM reservar_hueco($1,$2,$3,$4,$5,'Servicio Prueba','Clienta Web','34600000001',NULL,2)`,
        [ORG, contactId, STYLIST, ini, fin]
    ).then(r => ({ tipo: 'fila', ...r.rows[0] }))
     .catch(e => ({ tipo: 'excepcion', code: e.code || null, message: e.message }));
}

// La función de MEDIDA (4c). Nombre propio porque añade columnas al RETURNS y un
// CREATE OR REPLACE con otro tipo de retorno falla. Es el espejo de los pasos 1+6+7 de la
// original — el cerrojo, el check de solape y el INSERT —, que son los únicos que acotan la
// ventana del residuo: lo anterior (horario, bloqueos, tope) ocurre ANTES del snapshot del
// paso 6 y no forma parte de ella. t_check se toma justo antes del EXISTS (≈ su snapshot)
// y t_insert justo después del INSERT; el commit va fuera y lo cubre la cota de cliente.
const FUNCION_MEDIDA = `
CREATE FUNCTION reservar_hueco_medida(
    p_org uuid, p_contact uuid, p_stylist uuid,
    p_starts_at timestamptz, p_ends_at timestamptz
)
RETURNS TABLE (ok boolean, ventana_ms double precision)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $med$
DECLARE
    v_fecha date; v_t0 timestamptz; v_t1 timestamptz;
BEGIN
    v_fecha := (p_starts_at AT TIME ZONE 'Europe/Madrid')::date;
    PERFORM pg_advisory_xact_lock(
        hashtext(p_org::text || ':' || p_stylist::text || ':' || v_fecha::text)::bigint
    );
    v_t0 := clock_timestamp();
    IF EXISTS (
        SELECT 1 FROM appointments
         WHERE organization_id = p_org AND stylist_id = p_stylist
           AND status IS DISTINCT FROM 'cancelled'
           AND tstzrange(starts_at, ends_at) && tstzrange(p_starts_at, p_ends_at)
    ) THEN
        RETURN QUERY SELECT false, NULL::double precision; RETURN;
    END IF;
    INSERT INTO appointments (organization_id, contact_id, stylist_id, service,
        starts_at, ends_at, status, source, updated_by, full_name, phone, recordatorio_enviado)
    VALUES (p_org, p_contact, p_stylist, 'Medida', p_starts_at, p_ends_at,
        'confirmed', 'web', 'web', 'Medida', '34600000002', false);
    v_t1 := clock_timestamp();
    -- El delta se calcula AQUÍ y no en node: node-postgres trunca timestamptz a
    -- milisegundos y la ventana suele ser sub-milisegundo — medida en node daría 0.
    -- El cast es obligatorio: extract(epoch …) devuelve numeric y el RETURNS declara
    -- double precision — sin él, «structure of query does not match function result type».
    RETURN QUERY SELECT true, (extract(epoch FROM (v_t1 - v_t0)) * 1000.0)::double precision;
END;
$med$;`;

function estadisticas(muestras) {
    const s = [...muestras].sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const r = x => Math.round(x * 100) / 100;
    return { min: r(s[0]), mediana: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]), n: s.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────

(async () => {
    const url = resolverDestino();
    // Una rama de Supabase exige TLS en la conexión directa; un docker local no lo tiene.
    const ssl = /supabase\.(co|com)|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
    const pool = new Pool({ connectionString: url, max: N + 2, ssl });
    try {
        await bootstrapSiHaceFalta(pool);

        // La 043 tiene que estar puesta ANTES de probarla.
        const { rows: pre } = await pool.query(`
            SELECT (SELECT count(*)::int FROM pg_proc WHERE proname = 'reservar_hueco') AS fn,
                   (SELECT count(*)::int FROM pg_constraint WHERE conname = 'appointments_sin_solape_automatico') AS con`);
        if (!pre[0].fn || !pre[0].con) {
            console.error(`fail - la 043 no está en la BD destino (funcion=${pre[0].fn}, constraint=${pre[0].con}).`);
            process.exit(1);
        }
        // Se captura la definición REAL antes de mutar nada: la restauración repone esto,
        // no una copia pegada que podría divergir.
        const { rows: def } = await pool.query(
            `SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = 'reservar_hueco'`);
        const FUNCION_ORIGINAL = def[0].src;

        const s = await sembrar(pool);
        console.log(`ok - sembrado: org de prueba, estilista, ${N + 4} contactos, hueco ${s.fecha} 12:00 Madrid`);

        // ── Motivos del conjunto cerrado (deterministas, baratos, documentan el contrato) ─
        {
            const mal = await pool.query(
                `SELECT * FROM reservar_hueco($1,$2,$3,$4,$5,'x','x','x')`,
                [ORG, s.contactos[N], STYLIST, s.fin, s.ini]);
            ok(mal.rows[0].motivo === 'rango_invalido', 'fin <= inicio → rango_invalido', mal.rows[0]);

            const fuera = await pool.query(
                `SELECT * FROM reservar_hueco($1,$2,$3,
                    ((current_date + 1) + time '21:00') AT TIME ZONE 'Europe/Madrid',
                    ((current_date + 1) + time '22:00') AT TIME ZONE 'Europe/Madrid','x','x','x')`,
                [ORG, s.contactos[N], STYLIST]);
            ok(fuera.rows[0].motivo === 'fuera_de_horario', '21:00 con cierre a las 19:00 → fuera_de_horario', fuera.rows[0]);

            await pool.query(`INSERT INTO blocked_days (organization_id, stylist_id, fecha, motivo)
                              VALUES ($1, $2, current_date + 2, 'prueba')`, [ORG, STYLIST]);
            const bloq = await pool.query(
                `SELECT * FROM reservar_hueco($1,$2,$3,
                    ((current_date + 2) + time '12:00') AT TIME ZONE 'Europe/Madrid',
                    ((current_date + 2) + time '13:00') AT TIME ZONE 'Europe/Madrid','x','x','x')`,
                [ORG, s.contactos[N], STYLIST]);
            ok(bloq.rows[0].motivo === 'bloqueado', 'blocked_days (día entero) → bloqueado', bloq.rows[0]);

            const c = s.contactos[N + 1];
            for (const dia of [3, 4]) {
                await pool.query(
                    `SELECT * FROM reservar_hueco($1,$2,$3,
                        ((current_date + ${dia}) + time '12:00') AT TIME ZONE 'Europe/Madrid',
                        ((current_date + ${dia}) + time '13:00') AT TIME ZONE 'Europe/Madrid','x','x','x')`,
                    [ORG, c, STYLIST]);
            }
            const tope = await pool.query(
                `SELECT * FROM reservar_hueco($1,$2,$3,
                    ((current_date + 5) + time '12:00') AT TIME ZONE 'Europe/Madrid',
                    ((current_date + 5) + time '13:00') AT TIME ZONE 'Europe/Madrid','x','x','x')`,
                [ORG, c, STYLIST]);
            ok(tope.rows[0].motivo === 'tope_citas', 'tercera cita web futura del mismo contacto → tope_citas', tope.rows[0]);
        }

        // ── FASE 1 · normal ────────────────────────────────────────────────────────────
        {
            const r = await andanada(pool, s.contactos, s);
            ok(r.ganadoras === 1, `FASE 1 (normal): gana exactamente 1 de ${N}`, r);
            ok(r.filas === 1, 'FASE 1: exactamente 1 fila escrita sobre el hueco', r);
            ok(r.ocupado === N - 1, `FASE 1: las ${N - 1} perdedoras reciben hueco_ocupado limpio`, r);
            ok(r.crudas23P01 === 0 && r.otrasExcepciones.length === 0, 'FASE 1: cero excepciones crudas', r);
            await limpiarHueco(pool, s);
        }

        // ── FASE 2 · mutación A: sin EXCLUDE, sin cerrojo — tiene que ROMPERSE ────────────
        {
            await pool.query(`ALTER TABLE appointments DROP CONSTRAINT appointments_sin_solape_automatico`);
            await pool.query(FUNCION_SIN_CERROJO);
            const r = await andanada(pool, s.contactos, s);
            ok(r.ganadoras >= 2, `FASE 2 (mutación A): sin protección ganan ≥2 (ganaron ${r.ganadoras}) — la catástrofe existe`, r);
            ok(r.filas === r.ganadoras, 'FASE 2: cada ganadora es una fila real duplicada sobre el hueco', r);
            await limpiarHueco(pool, s);
            // restaurar
            await pool.query(FUNCION_ORIGINAL);
            await pool.query(`ALTER TABLE appointments
                ADD CONSTRAINT appointments_sin_solape_automatico
                EXCLUDE USING gist (organization_id WITH =, stylist_id WITH =,
                                    tstzrange(starts_at, ends_at) WITH &&)
                WHERE (source IN ('bot','web') AND status IS DISTINCT FROM 'cancelled'
                       AND stylist_id IS NOT NULL)`);
        }

        // ── FASE 3 · mutación B: EXCLUDE puesto, sin cerrojo ni handler ────────────────────
        {
            await pool.query(FUNCION_SIN_CERROJO);
            const r = await andanada(pool, s.contactos, s);
            ok(r.filas === 1, 'FASE 3 (mutación B): el EXCLUDE solo mantiene la tabla en 1 fila — es la garantía de verdad', r);
            ok(r.ganadoras === 1, 'FASE 3: sigue ganando exactamente 1', r);
            // Las perdedoras revientan CRUDO, pero el modo varía entre corridas: 23P01
            // (exclusion_violation) o 40P01 (deadlock detected — doce insertores
            // especulativos sobre el índice GiST esperándose en círculo; medido el
            // 20/08/2026: una corrida dio 11×23P01 y la siguiente 11×40P01). Los dos son
            // el mismo hecho: sin cerrojo, el fallo sale como excepción que nadie aguas
            // arriba sabe leer — y el 40P01 añade que también salen INTERBLOQUEOS.
            const crudas = r.crudas23P01 + r.otrasExcepciones.filter(e => e.code === '40P01').length;
            ok(crudas >= 1 && crudas === N - r.ganadoras - r.ocupado,
                `FASE 3: las perdedoras en ventana revientan CRUDO (${crudas}: 23P01 o 40P01) — lo que el cerrojo y el handler convierten en motivo limpio`, r);
            await limpiarHueco(pool, s);
            await pool.query(FUNCION_ORIGINAL);
        }

        // ── FASE 4 · web sobre cita MANUAL ─────────────────────────────────────────────
        // La ruta que el EXCLUDE parcial NO cubre (deja `manual` fuera de su predicado) y
        // que es el choque más probable: 57 de 58 citas reales son manuales. La única
        // protección es el paso 6 de reservar_hueco(), y hasta hoy estaba afirmada, no
        // medida.
        {
            // Todos los instantes de la fase, en un solo viaje. Día +1 para 4a/4b (el hueco
            // quedó limpio tras la FASE 3), día +6 para el residuo (4c), que necesita su
            // propio hueco virgen.
            const { rows: [T] } = await pool.query(`SELECT
                ((current_date + 1) + time '11:00') AT TIME ZONE 'Europe/Madrid' AS d1_1100,
                ((current_date + 1) + time '11:30') AT TIME ZONE 'Europe/Madrid' AS d1_1130,
                ((current_date + 1) + time '12:00') AT TIME ZONE 'Europe/Madrid' AS d1_1200,
                ((current_date + 1) + time '12:15') AT TIME ZONE 'Europe/Madrid' AS d1_1215,
                ((current_date + 1) + time '12:30') AT TIME ZONE 'Europe/Madrid' AS d1_1230,
                ((current_date + 1) + time '12:45') AT TIME ZONE 'Europe/Madrid' AS d1_1245,
                ((current_date + 1) + time '13:00') AT TIME ZONE 'Europe/Madrid' AS d1_1300,
                ((current_date + 1) + time '13:30') AT TIME ZONE 'Europe/Madrid' AS d1_1330,
                ((current_date + 1) + time '14:00') AT TIME ZONE 'Europe/Madrid' AS d1_1400,
                ((current_date + 6) + time '12:00') AT TIME ZONE 'Europe/Madrid' AS d6_1200,
                ((current_date + 6) + time '13:00') AT TIME ZONE 'Europe/Madrid' AS d6_1300`);

            const cWeb = s.contactos[0];           // sus filas de las fases 1-3 se limpiaron
            const cManual = s.contactos[N + 2];    // sin usar hasta ahora
            const filasSolapando = async (ini, fin) => {
                const { rows } = await pool.query(
                    `SELECT count(*)::int AS n FROM appointments
                      WHERE organization_id = $1 AND stylist_id = $2
                        AND status IS DISTINCT FROM 'cancelled'
                        AND tstzrange(starts_at, ends_at) && tstzrange($3, $4)`,
                    [ORG, STYLIST, ini, fin]);
                return rows[0].n;
            };

            // La cita MANUAL que ocupa 12:00–13:00 del día +1 — insertada a pelo, como la
            // insertaría el panel: sin cerrojo y sin pasar por reservar_hueco().
            await pool.query(
                `INSERT INTO appointments (organization_id, contact_id, stylist_id, service,
                    starts_at, ends_at, status, source, updated_by, full_name, phone, recordatorio_enviado)
                 VALUES ($1, $2, $3, 'Cita del panel', $4, $5, 'confirmed', 'manual', 'panel:prueba',
                    'Clienta Manual', '34600000003', false)`,
                [ORG, cManual, STYLIST, T.d1_1200, T.d1_1300]);

            // ── 4a · las cinco geometrías de solape, todas bloqueadas ──
            const geometrias = [
                ['idéntico',                 T.d1_1200, T.d1_1300],
                ['parcial por la izquierda', T.d1_1130, T.d1_1230],
                ['parcial por la derecha',   T.d1_1230, T.d1_1330],
                ['contenida en la manual',   T.d1_1215, T.d1_1245],
                ['contiene a la manual',     T.d1_1100, T.d1_1400],
            ];
            for (const [nombre, ini, fin] of geometrias) {
                const r = await llamadaRango(pool, cWeb, ini, fin);
                ok(r.tipo === 'fila' && r.motivo === 'hueco_ocupado',
                    `FASE 4a · solape ${nombre} sobre la MANUAL → hueco_ocupado`, r);
            }
            ok(await filasSolapando(T.d1_1100, T.d1_1400) === 1,
                'FASE 4a: tras las cinco, sobre el rango sigue habiendo SOLO la manual');

            // El CONTROL de falso positivo: adyacente SIN solape (tstzrange es `[)`, así
            // que 13:00–14:00 no toca a 12:00–13:00). Tiene que escribir — si no, la prueba
            // estaría midiendo cercanía y no solape.
            const ady = await llamadaRango(pool, cWeb, T.d1_1300, T.d1_1400);
            ok(ady.tipo === 'fila' && ady.ok === true,
                'FASE 4a · CONTROL: adyacente sin solape (13:00–14:00) SÍ reserva', ady);
            await pool.query(`DELETE FROM appointments WHERE id = $1`, [ady.cita_id]);

            // ── 4b · la mutación en rojo: la función real MENOS el paso 6 ──
            const mutSinPaso6 = sinPaso6(FUNCION_ORIGINAL);
            ok(!!mutSinPaso6, 'FASE 4b: la cirugía encontró los marcadores -- (6) / -- (7)');
            if (mutSinPaso6) {
                await pool.query(mutSinPaso6);
                const r = await llamadaRango(pool, cWeb, T.d1_1200, T.d1_1300);
                // Si esto NO sale ok=true —p. ej. un 23P01— la protección vive en otro
                // sitio del que creemos, y eso es un hallazgo de diseño, no un test verde.
                ok(r.tipo === 'fila' && r.ok === true,
                    'FASE 4b (mutación): SIN el paso 6 la web escribe ENCIMA de la manual — el rojo esperado. '
                    + 'Si esto falla, PARAR: la protección estaría en otro sitio del que creemos', r);
                ok(r.tipo !== 'excepcion' && r.code !== '23P01',
                    'FASE 4b: cero 23P01 — el EXCLUDE parcial NO ve a la manual (no está en su predicado)', r);
                ok(await filasSolapando(T.d1_1200, T.d1_1300) === 2,
                    'FASE 4b: dos filas solapadas en la tabla (web encima de manual)');
                if (r.cita_id) await pool.query(`DELETE FROM appointments WHERE id = $1`, [r.cita_id]);
                await pool.query(FUNCION_ORIGINAL);
            }

            // ── 4c · el residuo: EXISTE (ventana abierta) y cuánto MIDE ──
            // Existencia: la función entera CON el paso 6, más pg_sleep(0.25) justo después.
            // A llama; durante su sueño, el "panel" inserta la manual solapante y comitea
            // (sin cerrojo, como el panel real). A termina ok → el solape quedó escrito sin
            // que nadie lo viera. Es el residuo declarado en la 043, visto de verdad.
            const mutVentana = conVentanaAbierta(FUNCION_ORIGINAL);
            ok(!!mutVentana, 'FASE 4c: la cirugía de la ventana encontró el marcador -- (7)');
            if (mutVentana) {
                await pool.query(mutVentana);
                const promesaA = llamadaRango(pool, s.contactos[2], T.d6_1200, T.d6_1300);
                await new Promise(res => setTimeout(res, 100)); // A ya pasó el check y duerme
                await pool.query(
                    `INSERT INTO appointments (organization_id, contact_id, stylist_id, service,
                        starts_at, ends_at, status, source, updated_by, full_name, phone, recordatorio_enviado)
                     VALUES ($1, $2, $3, 'Cita del panel', $4, $5, 'confirmed', 'manual', 'panel:prueba',
                        'Clienta Manual 2', '34600000004', false)`,
                    [ORG, cManual, STYLIST, T.d6_1200, T.d6_1300]);
                const rA = await promesaA;
                ok(rA.tipo === 'fila' && rA.ok === true,
                    'FASE 4c · existencia: la manual comiteó DENTRO de la ventana y la web terminó ok', rA);
                ok(await filasSolapando(T.d6_1200, T.d6_1300) === 2,
                    'FASE 4c · existencia: el solape web+manual quedó escrito — el residuo es real');
                await pool.query(
                    `DELETE FROM appointments WHERE organization_id = $1 AND starts_at = $2`,
                    [ORG, T.d6_1200]);
                await pool.query(FUNCION_ORIGINAL);
            }

            // Tamaño: 40 iteraciones de la función de medida (ventana interna check→INSERT)
            // y 40 de la función real vista desde el cliente (cota superior, incluye commit
            // e ida y vuelta — aquí localhost; producción añade la red hasta Supabase).
            await pool.query(`DELETE FROM appointments WHERE organization_id = $1 AND starts_at = $2`,
                [ORG, T.d1_1200]); // fuera la manual de 4a: la medida necesita el hueco libre
            // IF EXISTS: una corrida anterior abortada pudo dejarla creada en el contenedor.
            await pool.query(`DROP FUNCTION IF EXISTS reservar_hueco_medida(uuid, uuid, uuid, timestamptz, timestamptz)`);
            await pool.query(FUNCION_MEDIDA);
            const ventanaMs = [];
            for (let i = 0; i < 40; i++) {
                const { rows: [m] } = await pool.query(
                    `SELECT * FROM reservar_hueco_medida($1,$2,$3,$4,$5)`,
                    [ORG, cWeb, STYLIST, T.d1_1200, T.d1_1300]);
                if (!m.ok) { ok(false, `FASE 4c · medida: iteración ${i} no reservó`, m); break; }
                ventanaMs.push(Number(m.ventana_ms));
                await pool.query(`DELETE FROM appointments WHERE organization_id = $1 AND starts_at = $2`,
                    [ORG, T.d1_1200]);
            }
            const clienteMs = [];
            for (let i = 0; i < 40; i++) {
                const t0 = process.hrtime.bigint();
                const r = await llamadaRango(pool, cWeb, T.d1_1200, T.d1_1300);
                const t1 = process.hrtime.bigint();
                if (!(r.tipo === 'fila' && r.ok === true)) { ok(false, `FASE 4c · cota cliente: iteración ${i} no reservó`, r); break; }
                clienteMs.push(Number(t1 - t0) / 1e6);
                await pool.query(`DELETE FROM appointments WHERE id = $1`, [r.cita_id]);
            }
            await pool.query(`DROP FUNCTION reservar_hueco_medida(uuid, uuid, uuid, timestamptz, timestamptz)`);
            ok(ventanaMs.length === 40 && clienteMs.length === 40,
                'FASE 4c · medida: las 80 iteraciones reservaron y se limpiaron');
            const vi = estadisticas(ventanaMs), vc = estadisticas(clienteMs);
            console.log(`\nRESIDUO MEDIDO (n=40, Postgres 17 local):`);
            console.log(`  ventana interna check→INSERT : min ${vi.min} · mediana ${vi.mediana} · p95 ${vi.p95} · max ${vi.max} ms`);
            console.log(`  llamada entera (cota superior): min ${vc.min} · mediana ${vc.mediana} · p95 ${vc.p95} · max ${vc.max} ms`);
            console.log(`  (la parte interna es del servidor y representativa; el commit y la red hasta`);
            console.log(`   Supabase van en la cota de cliente, que en producción será mayor que aquí)\n`);

            // Limpieza de la fase: fuera cualquier resto del día +1
            await pool.query(`DELETE FROM appointments WHERE organization_id = $1 AND starts_at = $2`,
                [ORG, T.d1_1200]);
        }

        // ── Estado final: todo restaurado ──────────────────────────────────────────────
        {
            const { rows: post } = await pool.query(`
                SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname = 'appointments_sin_solape_automatico') AS con,
                       (SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'reservar_hueco') AS src,
                       (SELECT count(*)::int FROM pg_proc WHERE proname = 'reservar_hueco_medida') AS medida`);
            ok(post[0].con === 1, 'restaurado: el EXCLUDE vuelve a estar puesto');
            ok(post[0].src === FUNCION_ORIGINAL, 'restaurado: la función es byte a byte la original');
            ok(post[0].medida === 0, 'restaurado: reservar_hueco_medida no existe (DROPeada)');
        }

        console.log(fallos === 0
            ? `\nPRUEBA CLAIM 043 · COMPLETA · ${N} concurrentes · 4 fases · mutaciones vistas en rojo · residuo medido`
            : `\nPRUEBA CLAIM 043 · ${fallos} FALLO(S)`);
        process.exit(fallos === 0 ? 0 : 1);
    } catch (e) {
        console.error('fail - error no capturado:', e.message);
        process.exit(1);
    } finally {
        await pool.end().catch(() => {});
    }
})();
