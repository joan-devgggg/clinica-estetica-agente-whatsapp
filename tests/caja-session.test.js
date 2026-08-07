// La sesión de caja del navegador (dashboard-app/src/lib/caja-session.ts).
//
// Es donde se decide qué pasa cuando el token caduca a mitad de jornada, y la respuesta no es
// obvia: se tira el TOKEN pero se conserva QUIÉN está en la caja. Si se borrara la sesión
// entera, al caducar habría que volver a elegir estilista — la clase de fricción por la que se
// acaba esquivando el PIN. Y el PIN no se guarda NUNCA.
//
// Se importa el .ts directamente (Node ≥ 23 quita los tipos solo). En un Node más viejo el
// test se salta en vez de romper `npm test`: mide una decisión de diseño, no la instalación.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'caja-session.ts');

function fakeStorage() {
    const datos = {};
    return {
        getItem: (k) => (k in datos ? datos[k] : null),
        setItem: (k, v) => { datos[k] = String(v); },
        removeItem: (k) => { delete datos[k]; },
        _datos: datos,
    };
}

let fallos = 0;
function test(name, fn) {
    try { fn(); console.log(`ok - ${name}`); }
    catch (e) { console.error(`fail - ${name}`); console.error(e.message); fallos++; process.exitCode = 1; }
}

(async () => {
    let cs;
    try {
        globalThis.window = { sessionStorage: fakeStorage() };
        cs = await import(`file://${RUTA}`);
    } catch (e) {
        console.log(`skip - caja-session: este Node no importa TypeScript (${e.code || e.message})`);
        console.log('\n✅ Sesión de caja OMITIDA (Node sin strip-types)');
        return;
    }

    const AHORA = 1_800_000_000_000;
    const sesionCon = (over = {}) => ({
        stylistId: 'est-irina', stylistName: 'Irina',
        token: 'tok', expiraEn: AHORA + 30 * 60_000, ...over,
    });

    test('1 · el PIN NO se guarda en el navegador, en ningún caso', () => {
        globalThis.window.sessionStorage = fakeStorage();
        cs.escribirSesion(sesionCon());
        const crudo = JSON.stringify(globalThis.window.sessionStorage._datos);
        assert.ok(!/pin/i.test(crudo), 'ni la palabra pin aparece en lo guardado');
        assert.deepStrictEqual(
            Object.keys(JSON.parse(Object.values(globalThis.window.sessionStorage._datos)[0])).sort(),
            ['expiraEn', 'stylistId', 'stylistName', 'token'],
        );
    });

    test('2 · dentro de ventana, la sesión sigue confirmada', () => {
        globalThis.window.sessionStorage = fakeStorage();
        cs.escribirSesion(sesionCon());
        const s = cs.leerSesion(AHORA + 29 * 60_000);
        assert.strictEqual(s.token, 'tok');
        assert.strictEqual(cs.atribucionDe(s), 'confirmada');
    });

    test('3 · al caducar se tira el TOKEN pero se conserva quién cobra', () => {
        globalThis.window.sessionStorage = fakeStorage();
        cs.escribirSesion(sesionCon());
        const s = cs.leerSesion(AHORA + 31 * 60_000);
        assert.ok(s, 'la sesión NO desaparece: si no, habría que re-elegir estilista');
        assert.strictEqual(s.stylistName, 'Irina', 'se sigue sabiendo a quién atribuir');
        assert.strictEqual(s.token, null);
        assert.strictEqual(cs.atribucionDe(s), 'declarada', 'baja a declarada, no bloquea');
    });

    test('4 · y la caducidad queda persistida: no revive al volver a leer', () => {
        globalThis.window.sessionStorage = fakeStorage();
        cs.escribirSesion(sesionCon());
        cs.leerSesion(AHORA + 31 * 60_000);
        const otra = cs.leerSesion(AHORA);          // reloj "hacia atrás"
        assert.strictEqual(otra.token, null, 'un token caducado no vuelve por mirar el reloj');
    });

    test('5 · renovar mueve la caducidad desde AHORA: es inactividad, no tiempo desde el PIN', () => {
        globalThis.window.sessionStorage = fakeStorage();
        cs.escribirSesion(sesionCon());
        const tarde = AHORA + 25 * 60_000;
        cs.renovarToken('tok2', 30, tarde);
        const s = cs.leerSesion(tarde);
        assert.strictEqual(s.token, 'tok2');
        assert.strictEqual(s.expiraEn, tarde + 30 * 60_000);
        // Con la caducidad vieja ya habría muerto; con la renovada, no.
        assert.ok(cs.leerSesion(tarde + 20 * 60_000).token, 'sigue viva 20 min después del último cobro');
    });

    test('6 · renovar con token vacío no rompe ni borra la sesión', () => {
        globalThis.window.sessionStorage = fakeStorage();
        cs.escribirSesion(sesionCon());
        cs.renovarToken(null, 30, AHORA);
        cs.renovarToken(undefined, 30, AHORA);
        assert.strictEqual(cs.leerSesion(AHORA).stylistName, 'Irina');
    });

    test('7 · sin sesión, atribución declarada y cero explosiones', () => {
        globalThis.window.sessionStorage = fakeStorage();
        assert.strictEqual(cs.leerSesion(AHORA), null);
        assert.strictEqual(cs.atribucionDe(null), 'declarada');
        cs.renovarToken('x', 30, AHORA);            // no hay a qué renovar
        assert.strictEqual(cs.leerSesion(AHORA), null);
    });

    test('8 · un sessionStorage corrupto no tumba la pantalla', () => {
        globalThis.window.sessionStorage = fakeStorage();
        globalThis.window.sessionStorage.setItem('caja.sesion.v1', '{roto');
        assert.strictEqual(cs.leerSesion(AHORA), null, 'se ignora en vez de lanzar');
    });

    test('9 · una sesión SIN estilista se descarta (no se atribuye a nadie)', () => {
        globalThis.window.sessionStorage = fakeStorage();
        globalThis.window.sessionStorage.setItem('caja.sesion.v1', JSON.stringify({ token: 'tok' }));
        assert.strictEqual(cs.leerSesion(AHORA), null);
    });


    // ── Quién cobra: el defecto sale de la CITA, no de la sesión ────────────
    // Que una atienda y cobre otra es lo normal en un mostrador compartido, así que el valor
    // de partida tiene que ser el del TRABAJO. Antes se atribuía siempre a la de la sesión,
    // que obligaba a meter otro PIN para decir algo que no tiene que ver con quién ha entrado.

    test('10 · el defecto es la estilista de la CITA, aunque haya otra con el PIN puesto', () => {
        const conIrina = sesionCon();                       // PIN de Irina
        assert.strictEqual(cs.estilistaPorDefecto('est-olga', conIrina), 'est-olga');
    });

    test('11 · una venta SIN cita arranca con la de la sesión: no hay cita de donde sacarla', () => {
        assert.strictEqual(cs.estilistaPorDefecto(null, sesionCon()), 'est-irina');
        assert.strictEqual(cs.estilistaPorDefecto(undefined, sesionCon()), 'est-irina');
    });

    test('12 · sin cita y sin sesión no se propone a nadie: hay que elegir', () => {
        assert.strictEqual(cs.estilistaPorDefecto(null, null), '');
    });

    test('13 · elegir a la del PIN puesto NO sale sin PIN; elegir a otra SÍ', () => {
        const conIrina = sesionCon();
        assert.strictEqual(cs.saldraSinPin(conIrina, 'est-irina'), false, 'coincide → con PIN');
        assert.strictEqual(cs.saldraSinPin(conIrina, 'est-olga'), true, 'otra → sin PIN, y se avisa antes');
    });

    test('14 · sin sesión, o con el token caducado, siempre sin PIN', () => {
        assert.strictEqual(cs.saldraSinPin(null, 'est-irina'), true);
        assert.strictEqual(cs.saldraSinPin(sesionCon({ token: null }), 'est-irina'), true);
    });

    console.log(fallos === 0 ? '\n✅ Sesión de caja OK' : `\n❌ ${fallos} fallo(s)`);
})();
