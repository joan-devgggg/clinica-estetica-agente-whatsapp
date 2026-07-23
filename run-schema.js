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

async function run() {
    const sql = fs.readFileSync(path.join(__dirname, 'supabase-schema.sql'), 'utf8');
    await client.connect();
    console.log('✅ Conectado a Supabase');
    await client.query(sql);
    console.log('✅ Tablas creadas correctamente');
    await client.end();
}

run().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
