// «PIN retirado» solo se dice si se retiró alguno.
//
// Hallazgo 5 de la auditoría del 12/08/2026. `clearStylistPin` tenía `assertWrite` —o sea que
// cubría un error de Supabase— pero NO miraba las filas afectadas, y devolvía `true` fijo. El
// endpoint contestaba `{ok:true}` y el panel cantaba «PIN retirado» aunque el DELETE no hubiera
// tocado nada: un `stylistId` que no casa, o de otra organización, y el PIN sigue puesto.
//
// Es exactamente el caso `deleteLead` del 07/08 («un borrado rechazado devolvía {ok:true} y el
// panel decía "borrado" sobre un contacto que seguía ahí»), y sus hermanas de esta misma capa
// —`setStylistPin`, `createCobro`— ya lo hacían bien. El daño va hacia el lado bueno (un PIN
// que sobrevive no atribuye de más: solo confirma quien de verdad lo teclea), pero la frase es
// falsa igual, y quien la lee deja de buscar.
//
// Hermético: Supabase falso en require.cache, cero red.
process.env.TZ = 'Europe/Madrid';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');

// `filas` = lo que el DELETE dice haber tocado. `fallar` = la BD lo rechaza.
const control = { filas: [{ stylist_id: 'est-irina' }], fallar: false };

function makeBuilder(tabla) {
    const run = () => (control.fallar
        ? { data: null, error: { code: 'PGRST301', message: `simulated failure on ${tabla}` } }
        : { data: control.filas, error: null });
    const b = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (onF, onR) => Promise.resolve(run()).then(onF, onR);
            if (prop === 'maybeSingle' || prop === 'single') {
                return () => ({ then: (onF, onR) => Promise.resolve(run()).then(onF, onR) });
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
const ORG = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

let pass = 0;
function test(nombre, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { pass++; console.log(`ok - ${nombre}`); })
        .catch(e => { console.error(`fail - ${nombre}\n    ${e.message}`); process.exitCode = 1; });
}

(async () => {
    await test('borra de verdad → true (el camino normal no cambia)', async () => {
        control.fallar = false;
        control.filas = [{ stylist_id: 'est-irina' }];
        assert.strictEqual(await db.clearStylistPin(ORG, 'est-irina'), true);
    });

    await test('no casa ninguna fila → false, NO un true de cortesía', async () => {
        control.filas = [];
        assert.strictEqual(await db.clearStylistPin(ORG, 'est-fantasma'), false,
            'sin filas afectadas no se ha retirado ningún PIN, y hay que poder saberlo');
    });

    await test('la BD rechaza el DELETE → lanza (assertWrite sigue en su sitio)', async () => {
        control.fallar = true;
        try {
            await db.clearStylistPin(ORG, 'est-irina');
        } catch { control.fallar = false; return; }
        control.fallar = false;
        throw new Error('un error de Supabase tiene que lanzar, no devolver false');
    });

    // El endpoint es el que convierte ese false en algo que se lee. Se comprueba sobre el
    // fuente porque montar el Express entero aquí traería auth, org-registry y medio webhook
    // para afirmar una línea.
    await test('DELETE /api/stylists/:id/pin no contesta ok cuando no retiró nada', () => {
        const fs = require('fs');
        const path = require('path');
        const fuente = fs.readFileSync(path.join(__dirname, '..', 'webhook.js'), 'utf8');
        const i = fuente.indexOf("app.delete('/api/stylists/:id/pin'");
        assert.notStrictEqual(i, -1, 'el endpoint tiene que seguir existiendo');
        const bloque = fuente.slice(i, i + 900);
        assert(/await db\.clearStylistPin\([^)]*\)/.test(bloque), 'sigue llamando a clearStylistPin');
        assert(/if \(!\w+\)/.test(bloque),
            'tiene que mirar el resultado: sin eso el {ok:true} es incondicional otra vez');
        assert(/404/.test(bloque),
            'y decirlo con un 404, que es lo que hace que el panel no cante "PIN retirado"');
    });

    console.log(`\n${pass} comprobaciones OK`);
})();
