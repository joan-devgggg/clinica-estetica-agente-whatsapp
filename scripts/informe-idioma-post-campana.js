#!/usr/bin/env node
/**
 * informe-idioma-post-campana.js — SOLO LECTURA. Mide la capa 1 de la guarda de idioma
 * (`persistirIdiomaObservado`, bot.js:1548) contra una tanda de campaña ya enviada.
 *
 * La pregunta que contesta: ¿qué fichas respondieron a la tanda, en cuántos segundos, y a
 * cuáles se les reescribió el idioma? Un autocontestador de otro negocio contesta en 7-10 s
 * y le fija a la ficha un `language_source: 'observed'` que significa "se lo hemos leído a
 * ELLA" — la etiqueta que decide qué plantilla de Meta recibe en la tanda siguiente.
 *
 * EL TRUCO QUE HACE LIMPIA LA MEDICIÓN: `broadcast_sends.template_name` codifica el idioma
 * que tenía la ficha EN EL MOMENTO DEL ENVÍO (el sufijo _ru2/_en2/_uk2). Comparado con
 * `contacts.language` de ahora, da el antes/después sin necesidad de haber guardado un
 * snapshot previo.
 *
 * OJO con el esquema: `messages` NO tiene `wa_phone` ni `body`. El teléfono va por
 * conversation_id → conversations.contact_id → contacts, y el texto es `content`. Una
 * consulta que pida `wa_phone` sobre `messages` devuelve error y, si no se mira el `error`,
 * un cero que parece "nadie respondió" (regla 4: pasó al escribir este informe).
 *
 *   node scripts/informe-idioma-post-campana.js                       ← última tanda
 *   node scripts/informe-idioma-post-campana.js 2026-08-12T10:46:00Z  ← desde ese instante
 */

require('dotenv').config();

const supabase = require('../services/supabase');

const ORG_ID = process.env.SANTE_ORG_ID || 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const CAMPAIGN_KEY = 'verano_tratamientos';
// El umbral de la capa 1 (RESPUESTA_AUTOMATICA_MS). Aquí solo se usa para CLASIFICAR el
// informe; la guarda de verdad vive en db.getRecentBroadcastSendAt.
const UMBRAL_S = 30;

/** El sufijo de la plantilla dice el idioma de la ficha en el instante del envío. */
function idiomaDeLaPlantilla(templateName) {
    const t = templateName || '';
    if (t.endsWith('_ru2')) return 'ru';
    if (t.endsWith('_en2')) return 'en';
    if (t.endsWith('_uk2')) return 'uk';
    return 'es';
}

/** `.in()` en trozos: Supabase no traga listas de cientos de ids de una vez. */
async function enLotes(tabla, columnas, campo, valores, tam = 200) {
    let out = [];
    for (let i = 0; i < valores.length; i += tam) {
        const { data, error } = await supabase
            .from(tabla).select(columnas)
            .eq('organization_id', ORG_ID).in(campo, valores.slice(i, i + tam));
        if (error) throw new Error(`${tabla}: ${error.message}`);
        out = out.concat(data || []);
    }
    return out;
}

async function main() {
    let desde = process.argv[2];
    if (!desde) {
        const { data, error } = await supabase.from('broadcast_sends')
            .select('sent_at').eq('organization_id', ORG_ID).eq('campaign_key', CAMPAIGN_KEY)
            .eq('status', 'sent').order('sent_at', { ascending: false }).limit(1);
        if (error) throw new Error(`ultimo envio: ${error.message}`);
        if (!data.length) throw new Error('no hay envíos de esta campaña');
        // 10 min hacia atrás desde el último: cubre la tanda entera sin tocar la anterior.
        desde = new Date(new Date(data[0].sent_at).getTime() - 10 * 60 * 1000).toISOString();
    }
    console.log(`Tanda desde: ${desde}\n`);

    const { data: envios, error: eEnv } = await supabase.from('broadcast_sends')
        .select('wa_phone, template_name, sent_at, contact_id')
        .eq('organization_id', ORG_ID).eq('campaign_key', CAMPAIGN_KEY)
        .eq('status', 'sent').gte('sent_at', desde);
    if (eEnv) throw new Error(`envios: ${eEnv.message}`);
    if (!envios.length) throw new Error('ningún envío en esa ventana');

    const sentAt = {}, langEnvio = {}, phonePorContacto = {};
    for (const e of envios) {
        sentAt[e.wa_phone] = e.sent_at;
        langEnvio[e.contact_id] = idiomaDeLaPlantilla(e.template_name);
        if (e.contact_id) phonePorContacto[e.contact_id] = e.wa_phone;
    }
    console.log(`Envíos en la tanda: ${envios.length}`);

    // ── Quién respondió, y a los cuántos segundos ────────────────────────────
    const ids = Object.keys(phonePorContacto);
    const convs = await enLotes('conversations', 'id, contact_id', 'contact_id', ids);
    const convAContacto = Object.fromEntries(convs.map(c => [c.id, c.contact_id]));

    const { data: msgs, error: eMsg } = await supabase.from('messages')
        .select('conversation_id, created_at, content')
        .eq('organization_id', ORG_ID).eq('direction', 'inbound')
        .gte('created_at', desde).order('created_at');
    if (eMsg) throw new Error(`messages: ${eMsg.message}`);

    const respuestas = {};
    for (const m of (msgs || [])) {
        const phone = phonePorContacto[convAContacto[m.conversation_id]];
        if (phone) (respuestas[phone] = respuestas[phone] || []).push(m);
    }

    const filas = Object.entries(respuestas).map(([phone, ms]) => ({
        phone,
        segundos: (new Date(ms[0].created_at) - new Date(sentAt[phone])) / 1000,
        n: ms.length,
        texto: (ms[0].content || '').replace(/\s+/g, ' ').slice(0, 60),
    })).sort((a, b) => a.segundos - b.segundos);

    console.log(`\n=== RESPONDIERON: ${filas.length} de ${envios.length} ===`);
    for (const f of filas) {
        const marca = f.segundos < UMBRAL_S ? '⚠ BAJO UMBRAL' : '  ';
        console.log(`${marca} ${f.phone} | ${f.segundos.toFixed(1)}s | n=${f.n} | ${JSON.stringify(f.texto)}`);
    }
    const sospechosas = filas.filter(f => f.segundos < UMBRAL_S);
    console.log(`\nBajo el umbral de ${UMBRAL_S}s (candidatas a centralita): ${sospechosas.length}`);
    if (filas.length) {
        console.log(`Respuesta HUMANA más rápida: ${filas.find(f => f.segundos >= UMBRAL_S)?.segundos.toFixed(1) ?? '—'}s ` +
            `→ margen sobre el umbral: ${((filas.find(f => f.segundos >= UMBRAL_S)?.segundos ?? UMBRAL_S) - UMBRAL_S).toFixed(1)}s`);
    }

    // ── Qué fichas cambiaron de idioma ───────────────────────────────────────
    const fichas = await enLotes('contacts', 'id, wa_phone, full_name, language, metadata, updated_at', 'id', ids);
    const cambiadas = fichas.filter(f => (f.language || 'es') !== langEnvio[f.id]);
    const tocadas = fichas.filter(f => f.updated_at && f.updated_at >= desde);

    console.log(`\n=== CAMBIARON DE IDIOMA DESDE EL ENVÍO: ${cambiadas.length} ===`);
    for (const f of cambiadas) {
        const md = f.metadata || {};
        console.log(`  ${f.wa_phone} ${(f.full_name || '').slice(0, 20).padEnd(20)} ` +
            `${langEnvio[f.id]} → ${f.language} | source:${md.language_source || '-'} | candidate:${md.language_candidate || '-'}`);
    }
    console.log(`\nFichas tocadas tras el envío: ${tocadas.length}`);
    for (const f of tocadas) {
        const md = f.metadata || {};
        console.log(`  ${f.wa_phone} ${(f.full_name || '').slice(0, 20).padEnd(20)} ` +
            `lang:${f.language} | source:${md.language_source || '-'} | ${f.updated_at}`);
    }

    // ── Veredicto sobre la capa 1 ────────────────────────────────────────────
    const cambiadasRapidas = cambiadas.filter(f => {
        const r = filas.find(x => x.phone === f.wa_phone);
        return r && r.segundos < UMBRAL_S;
    });
    console.log('\n=== CAPA 1 ===');
    if (!sospechosas.length) {
        console.log('Ninguna respuesta bajo el umbral: la guarda NO llegó a actuar en esta tanda.');
        console.log('Eso NO es evidencia de que funcione — es que no hubo nada que parar.');
    } else if (!cambiadasRapidas.length) {
        console.log(`La guarda paró las ${sospechosas.length} respuestas bajo umbral: ninguna reescribió idioma.`);
    } else {
        console.log(`⚠ ${cambiadasRapidas.length} ficha(s) bajo umbral SÍ cambiaron de idioma: la guarda no las paró.`);
        for (const f of cambiadasRapidas) console.log(`    ${f.wa_phone} ${f.full_name}`);
    }
}

main().then(() => process.exit(0)).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
