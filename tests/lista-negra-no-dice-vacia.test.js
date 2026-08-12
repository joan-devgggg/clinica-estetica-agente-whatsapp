// «Lista negra vacía» no se puede decir sobre una lectura que falló.
//
// Hallazgos 1 y 2 de la auditoría del 12/08/2026, y van juntos porque ninguno de los dos
// arreglos basta solo: `getBlacklist` devolvía `[]` ante un error de Supabase, y la pantalla
// tenía además su propio `catch { setItems([]) }`, así que aunque el endpoint pasara a dar 500
// seguiría pintando lo mismo. Hay que cortar las dos.
//
// Lo que se afirma con ese `[]` no es un hueco mudo, es una frase:
//
//     Lista negra vacía
//     Los no-shows y rechazos de Bizum se añaden aquí automáticamente
//
// O sea: «el mecanismo funciona y no ha atrapado a nadie». Y el día que se abre esa pantalla
// es el día del acosador del 10/08/2026 — la capacidad de urgencia que volvió al menú
// precisamente porque se usa el día que hace falta.
//
// El buscador es la segunda mitad y falla distinto: su `catch { setResults([]) }` se lee como
// «ese número no está en el sistema», y se está buscando a alguien para bloquearlo. Creer que
// no existe es irse sin bloquear.
//
// Tercera pieza, la que no es una línea de assertRead: `ejecutarAccion` (telegram.js) llama a
// getBlacklist desde `bot.on('message')`, que NO tiene try/catch. Hacer lanzar una función
// obliga a mirar todos sus call sites. Y ahí había ya un agujero anterior a esto:
// `setBlacklist`/`setVip`/`setConfigValue` LANZAN desde julio y este camino nunca los protegió,
// así que un bloqueo fallido desde Telegram ya tumbaba el proceso — el bot de las DOS orgs.
//
// Hermético: Supabase falso en require.cache, cero red, cero React.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ─── Supabase falso ──────────────────────────────────────────────────────────────────────
// `ceroFilasAlEscribir`: la LECTURA va bien y el UPDATE no casa ninguna fila. Es el caso que
// hace saltar assertRowsAffected, y no se puede montar solo con `failTables` (que tumba la
// tabla entera y entonces el contacto ni se encuentra: el test pasaría sin probar nada).
const control = { failTables: new Set(), rows: {}, ceroFilasAlEscribir: new Set() };

function makeBuilder(tabla) {
    let esEscritura = false;
    const run = () => {
        if (control.failTables.has(tabla)) {
            return { data: null, error: { code: 'PGRST301', message: `simulated failure on ${tabla}` } };
        }
        if (esEscritura && control.ceroFilasAlEscribir.has(tabla)) return { data: [], error: null };
        return { data: control.rows[tabla] ?? [], error: null };
    };
    const b = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (onF, onR) => Promise.resolve(run()).then(onF, onR);
            if (prop === 'maybeSingle' || prop === 'single') {
                return () => ({ then: (onF, onR) => Promise.resolve(run()).then(onF, onR) });
            }
            if (prop === 'update' || prop === 'insert' || prop === 'upsert' || prop === 'delete') {
                esEscritura = true;
            }
            return () => b;
        },
    });
    return b;
}

const supabasePath = require.resolve('../services/supabase');
require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true,
    exports: { from: (t) => makeBuilder(t) },
};

const db = require('../services/db');
const telegram = require('../services/telegram');

const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const PAGINA = path.join(__dirname, '..', 'dashboard-app', 'src', 'app', '(app)', 'lista-negra', 'page.tsx');

let pass = 0;
function test(nombre, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log(`ok - ${nombre}`); })
        .catch(e => { console.error(`fail - ${nombre}\n    ${e.message}`); process.exitCode = 1; });
}

async function lanza(fn, etiqueta) {
    try { await fn(); }
    catch { return; }
    throw new Error(`${etiqueta}: debería haber lanzado y no lanzó`);
}

/**
 * El cuerpo de una función del fuente, por llaves equilibradas. Cubre las dos formas que hay
 * en la página: `async function x(` y `const x = useCallback(async () => {`.
 */
function cuerpoDe(fuente, nombre) {
    let marca = fuente.indexOf(`function ${nombre}(`);
    if (marca === -1) marca = fuente.indexOf(`const ${nombre} =`);
    assert.notStrictEqual(marca, -1, `no existe la función ${nombre} en page.tsx`);
    const abre = fuente.indexOf('{', marca);
    let nivel = 0;
    for (let i = abre; i < fuente.length; i++) {
        if (fuente[i] === '{') nivel++;
        else if (fuente[i] === '}' && --nivel === 0) return fuente.slice(abre, i + 1);
    }
    throw new Error(`${nombre}: llaves sin cerrar`);
}

/**
 * El fuente SIN comentarios. Hace falta para el orden de la guarda: los comentarios que
 * explican el arreglo citan «Lista negra vacía», así que un `indexOf` sobre el fichero crudo
 * encuentra la cita y no el JSX. Se mide sobre lo que se ejecuta, no sobre lo que se lee.
 */
function sinComentarios(fuente) {
    return fuente
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}

const rechazosSinManejar = [];
process.on('unhandledRejection', (r) => { rechazosSinManejar.push(r); });

(async () => {
    // ─── 1. La capa de datos ─────────────────────────────────────────────────────────────
    await test('getBlacklist: un error de Supabase LANZA, no devuelve []', async () => {
        control.failTables = new Set(['contacts']);
        await lanza(() => db.getBlacklist(ORG), 'getBlacklist');
    });

    await test('getBlacklist: sin error devuelve la lista con sus campos', async () => {
        control.failTables = new Set();
        control.rows.contacts = [{
            id: 7, full_name: 'Alguien', wa_phone: '34600000009',
            is_blacklisted: true, blacklist_reason: 'No-show',
        }];
        const lista = await db.getBlacklist(ORG);
        assert.strictEqual(lista.length, 1);
        assert.strictEqual(lista[0].blacklist_reason, 'No-show', 'el motivo tiene que llegar: es lo que se pinta');
    });

    // El control que separa «no hay nadie bloqueado» de «no se pudo leer». Sin él, una función
    // que lanzara SIEMPRE también pasaría el bloque de arriba.
    await test('getBlacklist: una lista de verdad vacía sigue siendo [], y no lanza', async () => {
        control.failTables = new Set();
        control.rows.contacts = [];
        assert.deepStrictEqual(await db.getBlacklist(ORG), []);
    });

    // ─── 2. El call site sin red: Telegram ───────────────────────────────────────────────
    function botFalso() {
        const enviados = [];
        return { enviados, sendMessage: (_c, t) => { enviados.push(String(t)); } };
    }

    await test('Telegram «lista negra»: con la lectura caída NO propaga y NO dice que está vacía', async () => {
        control.failTables = new Set(['contacts']);
        const bot = botFalso();
        let salida;
        try {
            salida = await telegram._ejecutarAccion(ORG, 'list_blacklist', {}, bot, 111);
        } catch (e) {
            throw new Error(`no debe propagar al handler sin try/catch, y propagó: ${e.message}`);
        }
        assert(typeof salida === 'string' && salida.length, 'tiene que contestar algo');
        assert(!/vacía/i.test(salida), `no puede decir que está vacía: ${salida}`);
        assert(/no he podido|no se ha podido|no puedo/i.test(salida),
            `tiene que decir que no ha podido leerla: ${salida}`);
    });

    await test('Telegram «lista negra»: vacía de verdad sigue diciendo que está vacía', async () => {
        control.failTables = new Set();
        control.rows.contacts = [];
        const salida = await telegram._ejecutarAccion(ORG, 'list_blacklist', {}, botFalso(), 111);
        assert(/vacía/i.test(salida), `con cero bloqueados sí se dice; decía: ${salida}`);
    });

    await test('Telegram: una acción que LANZA (setBlacklist sin filas) no tumba el handler', async () => {
        // Agujero anterior a esta auditoría: setBlacklist lanza desde julio (assertRowsAffected)
        // y `bot.on('message')` nunca lo protegió. Se cubre aquí porque es el mismo call site.
        //
        // El contacto SÍ se encuentra (la lectura va bien) y el UPDATE no casa ninguna fila:
        // es el caso real de assertRowsAffected. Con `failTables` no valdría — la búsqueda
        // fallaría antes y el test pasaría por «no encontré a…», sin probar nada.
        control.failTables = new Set();
        control.rows.contacts = [{ id: 7, full_name: 'Alguien', wa_phone: '34600000009' }];
        control.ceroFilasAlEscribir = new Set(['contacts']);
        const bot = botFalso();
        let salida;
        try {
            salida = await telegram._ejecutarAccion(ORG, 'add_blacklist', { telefono: '34600000009' }, bot, 111);
        } catch (e) {
            throw new Error(`propagó y tumbaría el proceso: ${e.message}`);
        } finally {
            control.ceroFilasAlEscribir = new Set();
        }
        assert(typeof salida === 'string' && salida.length, 'tiene que contestar algo');
        assert(!/añadido a la lista negra/i.test(salida),
            `y NO puede decir que lo añadió, porque no lo añadió: ${salida}`);
    });

    // ─── 3. La pantalla ──────────────────────────────────────────────────────────────────
    const fuente = fs.readFileSync(PAGINA, 'utf8');

    await test('page.tsx: el catch de fetchItems registra el error, no vacía la lista', () => {
        const cuerpo = cuerpoDe(fuente, 'fetchItems');
        assert(/setError\(/.test(cuerpo),
            'fetchItems tiene que dejar constancia del fallo (setError), no tragárselo');
        assert(!/setItems\(\[\]\)/.test(cuerpo),
            'un fallo de lectura no puede pintarse como lista vacía: fuera el setItems([]) del catch');
    });

    await test('page.tsx: el catch de handleSearch avisa en vez de decir "no hay resultados"', () => {
        const cuerpo = cuerpoDe(fuente, 'handleSearch');
        assert(/toast\.error\(/.test(cuerpo),
            'una búsqueda que falla tiene que decirlo: se está buscando a alguien para bloquearlo');
    });

    await test('page.tsx: "Lista negra vacía" solo se pinta cuando NO hay error', () => {
        const jsx = sinComentarios(fuente);
        const vacia = jsx.indexOf('Lista negra vacía');
        assert.notStrictEqual(vacia, -1, 'el estado vacío tiene que seguir existiendo');
        const guarda = jsx.indexOf('error ? null :');
        assert.notStrictEqual(guarda, -1,
            'falta la guarda `error ? null :`: con error no se puede pintar el estado vacío');
        assert(guarda < vacia,
            'la guarda tiene que ir ANTES del estado vacío, o no lo cubre');
    });

    await test('page.tsx: hay un aviso visible con role="alert"', () => {
        assert(/role="alert"/.test(fuente),
            'sin banner el fallo no se ve en ningún sitio, que es de donde venimos');
        assert(/mensajeDeFallo|mensajeDeError/.test(fuente),
            'los mensajes en cristiano ya existen en lib/api: esta pantalla también los usa');
    });

    // ─── 4. Ni un rechazo sin manejar ────────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 50));
    await test('cero rechazos sin manejar', () => {
        assert.strictEqual(rechazosSinManejar.length, 0,
            `hubo ${rechazosSinManejar.length}: ${rechazosSinManejar.map(String).join(' · ')}`);
    });

    console.log(`\n${pass} comprobaciones OK`);
})();
