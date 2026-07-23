#!/usr/bin/env node
/**
 * create-dashboard-user.js — Alta de un usuario del dashboard en Supabase Auth.
 *
 * Crea (o actualiza la contraseña de) un usuario en auth.users con un email
 * sintético derivado del username, y vincula su fila en `profiles` a la
 * organización correspondiente. La contraseña se pide por un prompt OCULTO en
 * tiempo de ejecución — nunca se escribe en disco, ni en argumentos, ni en logs.
 *
 * Búsqueda del usuario existente: se usa la RPC `auth_user_id_by_email`
 * (migración 017) que hace una query específica por email, en vez de
 * admin.listUsers() — que puede fallar globalmente ("Database error finding
 * users") si alguna fila de auth.users tiene columnas de token en NULL.
 *
 * Uso:
 *   node scripts/create-dashboard-user.js
 *   node scripts/create-dashboard-user.js --username Sante --org b2c3d4e5-f6a7-8901-bcde-f12345678901
 *
 * Requiere en el entorno (.env del bot): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const { usernameToEmail } = require('./auth-email');

const SANTE_ORG_ID = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const m = argv[i].match(/^--([^=]+)=?(.*)$/);
        if (!m) continue;
        const key = m[1];
        const val = m[2] || argv[++i];
        args[key] = val;
    }
    return args;
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Prompt sin eco (contraseña). Patron estandar: SOLO readline consume stdin y
// muteamos el eco sobreescribiendo _writeToOutput. NO se anade un listener
// 'data' paralelo (competia con readline y perdia caracteres -> contrasena mal
// capturada, causa del primer fallo de login).
function askHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let muted = false;
        rl._writeToOutput = (str) => { if (!muted) rl.output.write(str); };
        rl.question(question, (value) => { rl.close(); process.stdout.write('\n'); resolve(value); });
        muted = true; // tras escribir el prompt: oculta lo tecleado
    });
}

// Busca el id del usuario por email con una query específica (RPC), sin listar
// todos los usuarios. Devuelve el uuid o null. Lanza si la RPC no existe.
async function findUserIdByEmail(admin, email) {
    const { data, error } = await admin.rpc('auth_user_id_by_email', { p_email: email });
    if (error) {
        throw new Error(
            `rpc auth_user_id_by_email: ${error.message}\n` +
            `  ¿Aplicaste la migración 017 (supabase/migrations/017_auth_admin_fixes.sql)?`
        );
    }
    return data || null; // la función devuelve un uuid escalar o null
}

async function main() {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
        console.error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
        process.exit(1);
    }

    const args = parseArgs(process.argv);
    const username = args.username || (await ask('Usuario (p. ej. Sante): '));
    if (!username) { console.error('Usuario requerido.'); process.exit(1); }
    const orgId = args.org || (await ask(`organization_id [${SANTE_ORG_ID}]: `)) || SANTE_ORG_ID;
    const password = await askHidden('Contraseña (no se mostrará): ');
    const password2 = await askHidden('Repite la contraseña: ');
    if (!password || password.length < 8) {
        console.error('La contraseña debe tener al menos 8 caracteres.');
        process.exit(1);
    }
    if (password !== password2) {
        console.error('Las contraseñas no coinciden. Abortado (no se ha cambiado nada).');
        process.exit(1);
    }

    const email = usernameToEmail(username);
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // 1) ¿Existe ya? Query específica por email (no listUsers).
    const existingId = await findUserIdByEmail(admin, email);

    // 2) Crear o actualizar la contraseña.
    let userId;
    if (existingId) {
        const { error } = await admin.auth.admin.updateUserById(existingId, { password, email_confirm: true });
        if (error) { console.error(`updateUser: ${error.message}`); process.exit(1); }
        userId = existingId;
        console.log(`Usuario existente: contraseña actualizada (${email}).`);
    } else {
        const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) { console.error(`createUser: ${error.message}`); process.exit(1); }
        userId = created.user.id;
        console.log(`Usuario creado (${email}).`);
    }

    // 3) Vincular profiles → organization_id.
    const { error: profErr } = await admin
        .from('profiles')
        .upsert({ id: userId, organization_id: orgId, role: 'owner' }, { onConflict: 'id' });
    if (profErr) { console.error(`upsert profiles: ${profErr.message}`); process.exit(1); }

    console.log(`Perfil vinculado a la organización ${orgId}.`);
    console.log(`\nListo. Inicia sesión con el usuario "${username}".`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
