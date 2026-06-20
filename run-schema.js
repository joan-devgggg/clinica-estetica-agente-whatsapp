/**
 * Crea las tablas en Supabase. Ejecutar una sola vez:
 *   node run-schema.js
 *
 * Requiere SUPABASE_DB_PASSWORD en .env
 * (Supabase Dashboard → Settings → Database → Database password)
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const password = process.env.SUPABASE_DB_PASSWORD;
const projectRef = 'bteoncgjpfqllnknwjdf';

if (!password) {
    console.error('❌ Falta SUPABASE_DB_PASSWORD en .env');
    console.error('   Encuéntrala en: Supabase Dashboard → Settings → Database → Database password');
    process.exit(1);
}

const client = new Client({
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password,
    ssl: { rejectUnauthorized: false },
});

const MIGRATIONS = [
    'supabase/migrations/000_drop_legacy.sql',
    'supabase/migrations/001_schema.sql',
    'supabase/migrations/002_seed.sql',
    'supabase/migrations/002_restaurante.sql',
];

async function run() {
    await client.connect();
    console.log('✅ Conectado a Supabase');
    for (const file of MIGRATIONS) {
        const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
        console.log(`→ Ejecutando ${file}...`);
        await client.query(sql);
    }
    console.log('✅ Migraciones aplicadas correctamente');
    await client.end();
}

run().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
