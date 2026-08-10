// Bloquear desde el panel: el menú de Sante y el texto de la confirmación.
//
// Por qué el texto merece un test. La confirmación no es adorno: es lo único que hay entre la
// dueña y una acción sobre una persona, y la mitad de lo que hace `is_blacklisted` no se
// adivina desde el botón. Dos cosas concretas se contradicen con la intuición —el bot todavía
// contesta UNA vez ("En breve te atenderá nuestro equipo", bot.js:3829) y el aviso de Telegram
// lleva un botón "✅ Sí, continuar" que DESBLOQUEA y encima le escribe (telegram.js:589-601)—.
// Si alguien reescribe la confirmación como "el bot dejará de contestarle", queda un panel que
// promete silencio mientras el sistema manda un mensaje: estos asserts fallan ahí.
//
// Y el menú se comprueba leyendo el fichero como TEXTO porque `app-sidebar.tsx` lleva JSX y no
// se puede `require` desde Node. Se parsea solo el array, no el render.
//
// Hermético: cero red, cero React, cero Supabase.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    confirmacionBloqueo, confirmacionDesbloqueo, nombreParaAviso,
    EFECTOS_BLOQUEO, EFECTOS_DESBLOQUEO,
} = require(path.join(__dirname, '..', 'dashboard-app', 'src', 'lib', 'blacklist.ts'));

const SIDEBAR = path.join(__dirname, '..', 'dashboard-app', 'src', 'components', 'layout', 'app-sidebar.tsx');
const FICHA = path.join(__dirname, '..', 'dashboard-app', 'src', 'components', 'clientes', 'cliente-edit-sheet.tsx');

let fallos = 0;
function test(nombre, fn) {
    try { fn(); console.log(`ok - ${nombre}`); }
    catch (e) { fallos++; console.error(`FALLO - ${nombre}\n   ${e.message}`); }
}

/** Los `href` de un array `const <nombre>: NavItem[] = [ … ];`, en orden. */
function hrefsDe(fuente, nombreArray) {
    const inicio = fuente.indexOf(`const ${nombreArray}: NavItem[] = [`);
    assert.notStrictEqual(inicio, -1, `no existe el array ${nombreArray} en app-sidebar.tsx`);
    const fin = fuente.indexOf('];', inicio);
    assert.notStrictEqual(fin, -1, `${nombreArray} sin cerrar`);
    return [...fuente.slice(inicio, fin).matchAll(/href:\s*"([^"]+)"/g)].map(m => m[1]);
}

// ─── Menú ────────────────────────────────────────────────────────────────────

const sidebar = fs.readFileSync(SIDEBAR, 'utf8');

test('Sante: "Lista negra" está en GESTIÓN, JUSTO debajo de "Lista VIP"', () => {
    const hrefs = hrefsDe(sidebar, 'salonSettingsItems');
    const vip = hrefs.indexOf('/lista-vip');
    const negra = hrefs.indexOf('/lista-negra');
    assert.notStrictEqual(negra, -1, 'la entrada /lista-negra no está en el menú de salón');
    assert.notStrictEqual(vip, -1, 'falta /lista-vip');
    assert.strictEqual(negra, vip + 1, `esperada justo detrás de Lista VIP; orden real: ${hrefs.join(' · ')}`);
});

test('Sante: "Lista negra" NO está también en el bloque PRINCIPAL (una entrada, no dos)', () => {
    assert.ok(!hrefsDe(sidebar, 'salonNavItems').includes('/lista-negra'));
});

test('La página /lista-negra sigue existiendo (la entrada del menú apunta a algo)', () => {
    const pagina = path.join(__dirname, '..', 'dashboard-app', 'src', 'app', '(app)', 'lista-negra', 'page.tsx');
    assert.ok(fs.existsSync(pagina), 'la ruta del menú no tiene página detrás');
});

// San Remo: el menú se fija entero, no solo "que no aparezca lista-negra". Lo que se protege
// es que tocar el de Sante no le mueva nada al otro — ni un orden, ni una entrada de más.
test('CONTROL San Remo: sus dos menús, byte por byte como estaban', () => {
    assert.deepStrictEqual(
        hrefsDe(sidebar, 'restaurantNavItems'),
        ['/', '/reservas', '/clientes', '/bizums', '/whatsapp'],
    );
    assert.deepStrictEqual(
        hrefsDe(sidebar, 'restaurantSettingsItems'),
        ['/lista-vip', '/lista-negra', '/configuracion'],
    );
});

// ─── La confirmación dice la verdad ──────────────────────────────────────────

const OLGA = { nombre: 'Olga Yarmak', telefono: '34674987146', is_blacklisted: false };

test('la confirmación identifica a quién se bloquea, con nombre Y teléfono', () => {
    const c = confirmacionBloqueo(OLGA);
    assert.ok(c.intro.includes('Olga Yarmak'), c.intro);
    // El teléfono es imprescindible, no un adorno: una ficha puede estar a nombre de otra
    // persona (un número que cambia de manos), y ahí el nombre identifica a quien NO se
    // está bloqueando. Es el caso real del 10/08/2026.
    assert.ok(c.intro.includes('34674987146'), c.intro);
});

test('una ficha sin nombre se identifica igual, por teléfono', () => {
    assert.strictEqual(nombreParaAviso({ nombre: '  ', telefono: '34600111222' }), '34600111222');
    assert.strictEqual(nombreParaAviso({ nombre: 'Ana', telefono: '' }), 'Ana');
});

const bloqueo = EFECTOS_BLOQUEO.join(' ').toLowerCase();

test('NO promete que el bot deje de contestar del todo (bot.js:3829 manda un mensaje más)', () => {
    // El aviso «En breve te atenderá nuestro equipo» sale la primera vez que escribe tras el
    // bloqueo, y vuelve a salir en cada sesión nueva: `blacklistNotified` no viaja en
    // buildSessionExtra. Prometer silencio total sería falso justo con quien más importa.
    assert.ok(/no se calla del todo|contest/.test(bloqueo), 'no menciona qué contesta el bot');
    assert.ok(bloqueo.includes('en breve te atenderá nuestro equipo'), 'no cita el mensaje que recibirá');
    assert.ok(!/deja de contestarle del todo|silencio total|no volverá a recibir nada/.test(bloqueo));
});

test('avisa del botón de Telegram que DESBLOQUEA (telegram.js:589-601)', () => {
    assert.ok(bloqueo.includes('telegram'), 'no menciona el aviso de Telegram');
    assert.ok(bloqueo.includes('desbloquea'), 'no avisa de que ese botón desbloquea');
});

test('dice que sigue viéndose en el Monitor y en Clientes (ninguno filtra lista negra)', () => {
    assert.ok(bloqueo.includes('monitor') && bloqueo.includes('clientes'), bloqueo);
});

test('dice que NO le llegan campañas, recordatorio ni reseña (los tres filtran de verdad)', () => {
    // getBroadcastAudience · getLeadsPendientesRecordatorio · getCompletedAppointmentsForReview.
    assert.ok(bloqueo.includes('campaña'), 'falta campañas');
    assert.ok(bloqueo.includes('recordatorio'), 'falta el recordatorio de 24 h');
    assert.ok(bloqueo.includes('reseña'), 'falta la petición de reseña');
});

test('dice que las citas NO se cancelan (setBlacklist solo escribe en contacts)', () => {
    assert.ok(/no se cancelan|siguen en la agenda/.test(bloqueo), bloqueo);
});

const desbloqueo = EFECTOS_DESBLOQUEO.join(' ').toLowerCase();

test('desbloquear avisa de que NO se envía ningún mensaje', () => {
    // Al revés que el "Sí, continuar" de Telegram y que el botón del Monitor, que sí escriben.
    assert.ok(desbloqueo.includes('no se le envía ningún mensaje'), desbloqueo);
});

test('desbloquear dice que vuelve el bot Y vuelven campañas/recordatorios/reseñas', () => {
    assert.ok(desbloqueo.includes('bot vuelve a contestarle'), desbloqueo);
    assert.ok(desbloqueo.includes('campaña') && desbloqueo.includes('recordatorio') && desbloqueo.includes('reseña'), desbloqueo);
});

test('los dos botones dicen el verbo, no "Aceptar"', () => {
    assert.strictEqual(confirmacionBloqueo(OLGA).cta, 'Bloquear');
    assert.strictEqual(confirmacionDesbloqueo(OLGA).cta, 'Desbloquear');
});

// ─── La ficha: la acción existe y es solo de Sante ───────────────────────────

const ficha = fs.readFileSync(FICHA, 'utf8');

test('la ficha de Clientes ofrece bloquear y desbloquear', () => {
    assert.ok(ficha.includes('Bloquear contacto'), 'falta el botón de bloquear');
    assert.ok(ficha.includes('Desbloquear contacto'), 'falta el botón de desbloquear');
});

test('CONTROL San Remo: la acción está gateada por isSalon', () => {
    // Sin el gate, la ficha del restaurante estrenaría un botón que nadie ha pedido, y encima
    // uno que dispara escrituras. La regla de oro es que San Remo no cambia de conducta.
    assert.ok(/isSalon && onBlock && onUnblock/.test(ficha),
        'la sección de lista negra debe estar dentro de un gate isSalon');
});

test('la acción PASA por la confirmación: nada llama a onBlock desde el botón', () => {
    // El botón abre el diálogo (`setConfirmando`); quien llama a onBlock/onUnblock es
    // `aplicarBlacklist`, detrás del "Bloquear" del diálogo. Si alguien cablea el botón
    // directamente a onBlock, desaparece la confirmación sin que nada más se entere.
    const enBoton = /onClick=\{\(\) => onBlock/.test(ficha) || /onClick=\{\(\) => onUnblock/.test(ficha);
    assert.ok(!enBoton, 'el botón llama a onBlock/onUnblock sin pasar por la confirmación');
    assert.ok(ficha.includes('setConfirmando("bloquear")'), 'el botón de bloquear no abre la confirmación');
    assert.ok(ficha.includes('setConfirmando("desbloquear")'), 'el botón de desbloquear no abre la confirmación');
});

console.log(fallos === 0 ? '\nTodos los tests OK' : `\n${fallos} test(s) FALLIDO(S)`);
process.exit(fallos === 0 ? 0 : 1);
