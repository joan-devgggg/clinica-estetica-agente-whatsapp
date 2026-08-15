#!/usr/bin/env node
/**
 * El marcador final de `npm test` — y el guardián de que la cadena esté COMPLETA.
 *
 * Existe por el falso verde del 15/08/2026: la cadena murió en el fichero 13 de 129 y el
 * log resultante eran 323 líneas donde todas decían «ok -», porque los fallos salen por
 * stderr y no había ninguna línea final que dijera si la corrida había terminado. Una
 * corrida truncada era indistinguible de una completa salvo contando líneas.
 * Historia: docs/incidentes-cerrados.md#npm-test-falso-verde
 *
 * Hace dos cosas, y las dos van juntas a propósito:
 *
 *   1. Imprime `SUITE COMPLETA · N ficheros` por STDOUT. Al ir el último de la cadena de
 *      `&&`, esa línea solo aparece si TODO lo anterior salió con 0. **Si no está, la
 *      corrida no terminó** — sirve incluso mirando solo stdout, que es justo el agujero
 *      por el que se coló el verde falso.
 *
 *   2. Comprueba que no haya `tests/*.test.js` FUERA de la cadena. El 15/08 había 10 que
 *      no corría nadie, y entre ellos `oferta-traspaso` — el test NUEVO del anillo 1,
 *      escrito y nunca enchufado, mientras el VIEJO que lo contradecía seguía en rojo. Un
 *      «N ficheros» que no mirase esto sería una cifra tranquilizadora y falsa.
 *
 * **N se CALCULA de la propia cadena**, nunca se escribe a mano: si mañana hay 140
 * ficheros, el marcador dirá 140 sin que nadie se acuerde de tocarlo.
 *
 * Un fichero puede quedarse fuera de la cadena, pero entonces se declara AQUÍ con su
 * motivo. Fuera-y-declarado es una decisión; fuera-y-en-silencio es el bug de arriba.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Los que están fuera A PROPÓSITO. Sin entrada aquí, un test fuera de la cadena es un fallo.
const FUERA_A_PROPOSITO = {
    'tests/helpers.test.js':
        'LEGACY del embudo pre-multi-tenant (getStepFromPartialData / responseMatchesStep / '
        + '«city and budget»): 3 bloques en rojo desde que ese flujo dejó de existir. Rojo del '
        + 'TEST, no del sistema. Medido el 15/08/2026.',
    'tests/blacklist-reconcile.test.js':
        'NO es hermético y quedó anterior a la migración a 360dialog: manda mensajes con id de '
        + 'whatsapp-web.js y el guard de canal los descarta (mensaje_ignorado_canal_inactivo), '
        + 'así que la sesión no llega a existir. 3/3 en rojo por el arnés. Medido el 15/08/2026.',
    'tests/escalation-flow.test.js':
        'Mismo caso que blacklist-reconcile, y además habla con la Supabase REAL (carga .env por '
        + 'bot.js y no intercepta el cliente): «contacto debe existir en Supabase». 5/6 en rojo. '
        + 'No puede entrar en npm test sin volverlo no-hermético. Medido el 15/08/2026.',
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const cadena = (pkg.scripts && pkg.scripts.test ? pkg.scripts.test : '')
    .split('&&')
    .map(s => s.trim())
    .map(s => (s.match(/^node\s+(tests\/[\w.-]+\.test\.js)$/) || [])[1])
    .filter(Boolean);

const enDisco = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(f => f.endsWith('.test.js'))
    .map(f => `tests/${f}`)
    .sort();

const enCadena = new Set(cadena);
const huerfanos = enDisco.filter(f => !enCadena.has(f) && !FUERA_A_PROPOSITO[f]);
// Al revés también importa: una entrada de la cadena que ya no existe en disco haría que
// `npm test` muriese con «Cannot find module» y nadie sabría por qué.
const fantasmas = cadena.filter(f => !fs.existsSync(path.join(ROOT, f)));

if (huerfanos.length || fantasmas.length) {
    for (const f of huerfanos) {
        console.error(`fail - ${f} existe pero NO está en la cadena de \`npm test\`: no lo corre nadie.`);
    }
    for (const f of fantasmas) {
        console.error(`fail - ${f} está en la cadena pero no existe en disco.`);
    }
    console.error(
        '\nAñádelo a `scripts.test` en package.json, o —si de verdad tiene que quedarse fuera—\n'
        + 'declara el motivo en FUERA_A_PROPOSITO (scripts/suite-completa.js). Fuera y declarado\n'
        + 'es una decisión; fuera y en silencio es cómo `oferta-traspaso` pasó semanas sin correr.');
    process.exit(1);
}

const fuera = Object.keys(FUERA_A_PROPOSITO).length;
console.log(`SUITE COMPLETA · ${cadena.length} ficheros`
    + (fuera ? ` · ${fuera} fuera a propósito (ver scripts/suite-completa.js)` : ''));
process.exit(0);
