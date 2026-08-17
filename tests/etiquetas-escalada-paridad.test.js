// Las etiquetas de escalada vivían copiadas en CINCO sitios y ninguno coincidía con otro:
// los 8 casos del prompt de Sante, la enumeración del esquema JSON del MISMO prompt —que se
// había quedado sin `dato_no_disponible` mientras el caso 7 le pedía justo ese valor—, el
// espacio `consulta_*` que construye bot.js, el mapa de Telegram y el del panel.
//
// De los CINCO motivos que existían en producción el 17/08/2026, DOS se pintaban en crudo a
// quien tenía que atenderlos: `servicio_especial` (fila del 09/08) y `consulta_dato_no_disponible`
// (la escalada de Mafe del 12/08). Ni Telegram ni el panel los conocían.
//
// Ahora la fuente es helpers.ETIQUETAS_ESCALADA. Telegram la importa, así que no puede
// separarse. El PANEL es otra app y mantiene su copia a mano: esta es la red que lo vigila,
// y falla con el nombre de la clave que falte. Misma raya que service-names-parity: aquí se
// prueba PARIDAD de dos listas deterministas, hermético y sin Supabase.
//
// Visto fallar sin lo que protege (sabotajes con cp previo, rojos MEDIDOS el 18/08/2026):
//   · quitar `consulta_dato_no_disponible` del mapa del panel → 1 rojo, con la clave impresa;
//   · quitar `dato_no_disponible` de MOTIVOS_LLM → 2 rojos (paridad del panel y la
//     enumeración del prompt, que es la regresión exacta de openai.js:1034);
//   · devolver a telegram.js su mapa propio → 1 rojo (deja de importar la fuente).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    ETIQUETAS_ESCALADA, MOTIVOS_LLM, MOTIVOS_OFRECIBLES, ESPERAS_ESCALADA, RAZONES_DE_CODIGO,
} = require('../services/helpers');

const CHATVIEW = path.join(__dirname, '..', 'dashboard-app', 'src', 'components', 'whatsapp', 'ChatView.tsx');
const TELEGRAM = path.join(__dirname, '..', 'services', 'telegram.js');
const OPENAI = path.join(__dirname, '..', 'services', 'providers', 'openai.js');

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`fail - ${nombre}\n   ${e.message}`); }
}

// El panel no se puede `require` (es JSX y no lo estrecha el type-stripping de Node), así que
// se leen las claves del TEXTO. Es a propósito: lo que se vigila es que la lista esté al día,
// no cómo la escribe React.
function clavesDelPanel() {
    const src = fs.readFileSync(CHATVIEW, 'utf8');
    const bloque = src.split('const ESCALATION_LABELS')[1];
    assert.ok(bloque, 'no encuentro ESCALATION_LABELS en ChatView.tsx — ¿se renombró?');
    const cuerpo = bloque.split('};')[0];
    return new Set([...cuerpo.matchAll(/^\s*([a-z_]+)\s*:/gm)].map(m => m[1]));
}

test('el panel conoce TODAS las razones que el bot puede escribir', () => {
    const panel = clavesDelPanel();
    const faltan = Object.keys(ETIQUETAS_ESCALADA).filter(k => !panel.has(k));
    assert.deepStrictEqual(faltan, [],
        `el panel las pintaría en CRUDO (ChatView.tsx cae a `
        + `conversation.escalation_reason): ${faltan.join(', ')}`);
});

test('el panel no inventa razones que nadie escribe', () => {
    const panel = clavesDelPanel();
    const sobran = [...panel].filter(k => !ETIQUETAS_ESCALADA[k]);
    assert.deepStrictEqual(sobran, [],
        `claves en el panel que no existen en helpers.ETIQUETAS_ESCALADA: ${sobran.join(', ')}`);
});

test('telegram.js NO tiene mapa propio: importa la fuente única', () => {
    const src = fs.readFileSync(TELEGRAM, 'utf8');
    assert.ok(/require\(['"]\.\/helpers['"]\)/.test(src) && /etiquetaEscalada/.test(src),
        'telegram.js debe usar helpers.etiquetaEscalada');
    assert.ok(!/const ESCALATION_LABELS\s*=\s*\{/.test(src),
        'telegram.js ha vuelto a tener su propio mapa de etiquetas — es la copia que se quedó '
        + 'sin servicio_especial ni consulta_dato_no_disponible');
});

test('la enumeración del prompt se RENDERIZA de la lista, no se escribe a mano', () => {
    const src = fs.readFileSync(OPENAI, 'utf8');
    // La regresión concreta: openai.js:1034 enumeraba cinco motivos a mano y se había
    // quedado sin dato_no_disponible mientras el caso 7 se lo pedía al modelo.
    assert.ok(/motivo_escalado: solo cuando accion es "escalar_humano" → \$\{MOTIVOS_LLM_STR\}/.test(src),
        'la línea de motivo_escalado del esquema volvió a estar escrita a mano');
    assert.ok(/const MOTIVOS_LLM_STR = Object\.keys\(MOTIVOS_LLM\)/.test(src),
        'MOTIVOS_LLM_STR debe derivarse de helpers.MOTIVOS_LLM');
});

test('el caso 7 del prompt le pide al modelo el campo que el normalizador acepta', () => {
    const src = fs.readFileSync(OPENAI, 'utf8');
    for (const motivo of MOTIVOS_OFRECIBLES) {
        assert.ok(src.includes(`ofrezco_traspaso: "${motivo}"`),
            `el prompt no le dice al modelo que ponga ofrezco_traspaso: "${motivo}" en ningún caso`);
    }
});

test('ofrecible SOLO donde el flujo está cableado (hoy: dato_no_disponible)', () => {
    // No es cosmético: el normalizador acepta este conjunto y bot.js arma una espera con él,
    // que se escribe como `consulta_<valor>`. Un motivo ofrecible sin flujo armaría una
    // espera que nadie sabe resolver, y su `consulta_*` no tendría etiqueta.
    assert.deepStrictEqual(MOTIVOS_OFRECIBLES, ['dato_no_disponible']);
    for (const m of MOTIVOS_OFRECIBLES) {
        assert.ok(ESPERAS_ESCALADA[m], `ofrecible sin tipo de espera: ${m}`);
        assert.ok(ETIQUETAS_ESCALADA[`consulta_${m}`], `sin etiqueta para consulta_${m}`);
    }
});

test('los tres vocabularios no se pisan y el mapa plano los cubre', () => {
    assert.strictEqual(
        Object.keys(ETIQUETAS_ESCALADA).length,
        Object.keys(MOTIVOS_LLM).length + Object.keys(ESPERAS_ESCALADA).length + Object.keys(RAZONES_DE_CODIGO).length,
        'alguna clave se solapa entre MOTIVOS_LLM / consulta_* / RAZONES_DE_CODIGO y una etiqueta pisa a otra',
    );
    for (const [k, v] of Object.entries(ETIQUETAS_ESCALADA)) {
        assert.ok(typeof v === 'string' && v.length > 3, `etiqueta vacía o sospechosa para ${k}`);
    }
});

// Las cinco razones que EXISTEN hoy en pending_actions de Sante (leídas el 18/08/2026).
// Congeladas a propósito: son las que ya se le han enseñado a alguien.
test('las razones vivas en producción tienen etiqueta', () => {
    for (const r of ['queja_cita', 'pedir_persona', 'servicio_especial',
        'consulta_permanente', 'consulta_dato_no_disponible']) {
        assert.ok(ETIQUETAS_ESCALADA[r], `sin etiqueta: ${r} (existe en producción)`);
    }
});

if (fallos) { console.error(`\n${fallos} fallo(s) de paridad de etiquetas de escalada`); process.exit(1); }
console.log('\nParidad de etiquetas de escalada OK');
