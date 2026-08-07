// Pedir una foto tiene respuesta, y sale de un DATO editable (07/08/2026).
//
// Olga Yarmak escribió «А можно фото их» a las 15:41:12 y recibió el menú de rescate por
// tercera vez. Dos capas del mismo fallo:
//   · la mitad BUG (arreglada aparte): la red anti-invención se comía la respuesta del LLM
//     en cuanto citaba el horario;
//   · la mitad DISEÑO QUE FALTA, que es esta: el bot no tiene salida de media —en
//     threesixty-dialog los tipos image/video son solo de ENTRADA— y business_info de Sante
//     no tenía ni instagram ni web (claves reales el 07/08: equipo, stripe, botName, horario,
//     idiomas, whatsapp, direccion, upselling, cancelacion, companyName, horasResena,
//     googleReviewLink). O sea que no había nada que mandar y ningún sitio adonde mandarla.
//
// Los enlaces son DATO de business_info, no constantes: los edita la dueña desde el panel y
// un enlace escrito en el código mediría antigüedad (regla 5). Por eso el test usa valores
// inventados — si alguien los fija en el fichero, esto se cae.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { buildSystemPrompt } = require('../services/providers/openai');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const BASE = {
    companyName: 'Salón de prueba',
    direccion: 'Calle Falsa 123',
    horario: 'Lunes a Sábado: 11:00–20:00',
    cancelacion: 'Avisar con 48 horas',
};

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

function prompt(businessInfo) {
    // buildSystemPrompt(orgId, partialData, intent, reservaConfirmada, summary, agentCfg)
    return buildSystemPrompt(SANTE, {}, null, false, null, {
        business_info: { ...BASE, ...businessInfo },
        services: [],
        tone: 'cercano',
    });
}

test('con enlaces: el prompt los lleva y manda pasarlos', () => {
    const p = prompt({ instagram: 'https://instagram.com/ejemplo_salon' });
    assert.ok(p.includes('https://instagram.com/ejemplo_salon'), 'el enlace no llega al prompt');
    assert.ok(/FOTOS:/.test(p), 'falta la instrucción de fotos');
    assert.ok(/no puedes enviar im[áa]genes/i.test(p));
});

test('la web también', () => {
    const p = prompt({ web: 'https://ejemplo.es' });
    assert.ok(p.includes('https://ejemplo.es'));
});

test('SIN enlaces: no se promete nada y se ofrece la consulta', () => {
    // Regla 3: si el dato no está, no se inventa un enlace ni se promete una foto que no va
    // a llegar. Es exactamente lo que hacía falta el 07/08, cuando no había ningún campo.
    const p = prompt({});
    assert.ok(/FOTOS:/.test(p), 'la instrucción tiene que estar igualmente');
    assert.ok(/consulta de valoraci[óo]n/i.test(p.split('FOTOS:')[1].slice(0, 400)));
    assert.ok(!/instagram\.com/i.test(p), 'no puede colarse ningún enlace inventado');
    assert.ok(/NO prometas mandarlas/.test(p), 'tiene que prohibir prometer una foto que no llega');
});

test('los enlaces salen del config, no de una constante', () => {
    // Dos configs distintos → dos prompts distintos. Un enlace escrito en el fichero pasaría
    // el primer test y fallaría este.
    const a = prompt({ instagram: 'https://instagram.com/salon_a' });
    const b = prompt({ instagram: 'https://instagram.com/salon_b' });
    assert.ok(a.includes('salon_a') && !a.includes('salon_b'));
    assert.ok(b.includes('salon_b') && !b.includes('salon_a'));
});

(async () => {
    let fallos = 0;
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { fallos++; console.error(`FALLO - ${name}\n   ${e.message}`); }
    }
    console.log(fallos ? `\n❌ ${fallos} fallo(s)` : `\n✅ ${tests.length} en verde`);
    process.exit(fallos ? 1 : 0);
})();
