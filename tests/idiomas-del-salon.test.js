// Los idiomas del BOT no son los idiomas del SALÓN (19/08/2026).
//
// En una conversación en francés el bot escribió «L'équipe du salon t'aidera». La mitad
// verdadera: el equipo la atiende. La mitad falsa, y es la que llega: que la atienden en
// francés. En el salón se habla español, inglés, ruso y ucraniano; con cualquier otro
// idioma se apañan con un traductor.
//
// Lo que NO se toca, porque es lo que Yulia quiere conservar: el bot sigue respondiendo en
// el idioma de la clienta, sea cual sea. El arreglo no cierra la puerta al francés — cierra
// la afirmación sobre el equipo.
//
// La lista es DATO (`business_info.idiomas`, seed 003_sante.sql, vivo en producción y sin
// un solo lector hasta hoy) y no una constante, por la regla 5: cambia cuando cambia el
// equipo. Y NO se deriva de `IDIOMAS_SOPORTADOS` aunque hoy sean las mismas cuatro — esa
// constante es «en qué idiomas tiene textos fijos y plantillas la MÁQUINA», que es otra
// cosa. Que coincidieran es justo la casualidad de la que salió el mensaje en francés.
//
// Por eso los valores de este fichero son INVENTADOS: si alguien escribe la lista real en
// el código, el bloque 2 se cae.
process.env.TZ = 'Europe/Madrid';

const assert = require('assert');
const { buildSystemPrompt } = require('../services/providers/openai');
const { IDIOMAS_SOPORTADOS } = require('../services/helpers');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SANTE = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const SANREMO = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

const BASE = {
    companyName: 'Salón de prueba',
    direccion: 'Calle Falsa 123',
    horario: 'Lunes a Sábado: 11:00–20:00',
    cancelacion: 'Avisar con 48 horas',
};

function prompt(businessInfo) {
    return buildSystemPrompt(SANTE, {}, null, false, null, {
        business_info: { ...BASE, ...businessInfo }, services: [], tone: 'cercano',
    });
}

// La sección entera, para poder afirmar que algo NO está SIN que lo tape el resto del
// prompt (que menciona los cuatro idiomas en los ejemplos de `idioma_detectado`).
function seccion(p) {
    const i = p.indexOf('IDIOMAS DEL SALÓN');
    if (i < 0) return '';
    const j = p.indexOf('# ── EL SALÓN', i);
    return p.slice(i, j < 0 ? p.length : j);
}

// ─── 1 · Con la lista: se dice, y se prohíbe atribuirle el idioma al equipo ──────────

test('con la lista: el prompt la lleva y prohíbe dar a entender que el equipo la habla', () => {
    const s = seccion(prompt({ idiomas: ['klingon', 'sindarin', 'quenya'] }));
    assert.ok(s, 'no hay sección de idiomas del salón en el prompt');
    assert.ok(/klingon, sindarin y quenya/.test(s), `la lista no sale bien formada:\n${s}`);
    assert.ok(/traductor/.test(s), 'falta lo del traductor, que es la mitad tranquilizadora');
    assert.ok(/NUNCA puedes hacer es dar a entender que el equipo habla/.test(s),
        'falta la prohibición, que es TODO el arreglo');
});

test('el bot NO deja de contestar en el idioma de la clienta: eso se afirma aquí mismo', () => {
    const p = prompt({ idiomas: ['klingon'] });
    const s = seccion(p);
    assert.ok(/sigues respondiendo SIEMPRE en el idioma de la clienta/.test(s),
        'la sección tiene que reafirmar lo que NO cambia, o el modelo lee la prohibición '
        + 'como «no le contestes en ese idioma»');
    assert.ok(!/\(es\/en\/ru\/uk\)/.test(p),
        'la regla dura 7 seguía capando la respuesta a cuatro idiomas');
    assert.ok(/pon su código ISO igual que los demás/.test(p),
        'el código de un idioma de fuera es la SEÑAL con la que la máquina se entera; '
        + 'pedirle que lo deje en null la apaga — que es como se perdió la primera vez');
});

test('la exención está escrita, y la frase NO se la pide a la prosa del modelo', () => {
    // Regla 12 en versión prompt: antes de añadir nada hay que decir qué mensaje BUENO no
    // puede perderse. El bueno es la conversación normal de una clienta rusa, que no tiene
    // por qué enterarse de nada de esto.
    //
    // El tope de repetición y el «no si no viene a cuento» YA NO viven aquí: los decide la
    // máquina (`idiomasSalonAvisado` y el campo `frase_idiomas_salon`), y se afirman en
    // tests/idiomas-del-salon-coda.test.js. Está medido que en la prosa no se sostienen.
    const s = seccion(prompt({ idiomas: ['klingon'] }));
    assert.ok(/SÍ está en esa lista, no menciones NADA/.test(s), 'falta la exención');
    assert.ok(/De decírselo se encarga el sistema, no tú/.test(s),
        'si el prompt no le dice que de la frase se encarga el sistema, la pone él además '
        + 'y sale dos veces');
    assert.ok(!/frase_idiomas_salon/.test(s),
        'el nombre del campo no puede salir en una conversación donde ese campo no existe: '
        + 'es invitarle a emitirlo por su cuenta');
});

// ─── 1 bis · El campo, que es el mecanismo de verdad ────────────────────────────────

test('el campo solo se le pide cuando la MÁQUINA ya sabe que hace falta', () => {
    const conFlag = buildSystemPrompt(SANTE, { __idiomaSinCodigo: true }, null, false, null, {
        business_info: { ...BASE, idiomas: ['klingon'] }, services: [], tone: 'cercano',
    });
    const sinFlag = prompt({ idiomas: ['klingon'] });
    assert.ok(/frase_idiomas_salon/.test(conFlag), 'con la marca, el campo tiene que estar');
    assert.ok(!/frase_idiomas_salon/.test(sinFlag),
        'sin la marca no existe: así una conversación en ruso no puede recibirlo NUNCA, '
        + 'y la exención deja de depender de que el modelo la respete');
    assert.ok(/"frase_idiomas_salon": null,/.test(conFlag),
        'la clave va también en el objeto de EJEMPLO: una clave que no está en el ejemplo '
        + 'se le olvida — medido, 1 de 2 corridas sin ella');
    assert.ok(/ponla en null/.test(conFlag),
        'falta el gate del «no viene a cuento», que ahora vive en el campo');
});

test('sin `idiomas` no se pide el campo aunque la marca esté puesta', () => {
    const p = buildSystemPrompt(SANTE, { __idiomaSinCodigo: true }, null, false, null, {
        business_info: { ...BASE }, services: [], tone: 'cercano',
    });
    assert.ok(!/frase_idiomas_salon/.test(p),
        'sin lista no hay frase que traducir: pedirla sería pedirle que se la invente');
});

// ─── 2 · Sale del DATO, no de una constante ─────────────────────────────────────────

test('dos configs distintos → dos prompts distintos', () => {
    const a = seccion(prompt({ idiomas: ['klingon'] }));
    const b = seccion(prompt({ idiomas: ['sindarin'] }));
    assert.ok(a.includes('klingon') && !a.includes('sindarin'));
    assert.ok(b.includes('sindarin') && !b.includes('klingon'));
});

test('la lista NO se deriva de IDIOMAS_SOPORTADOS', () => {
    // Si alguien la sustituye por la constante, este bloque se cae: la constante no sabe
    // decir «klingon», y con un solo idioma tampoco escribiría uno solo.
    const s = seccion(prompt({ idiomas: ['klingon'] }));
    assert.ok(/hablan klingon\./.test(s), `con un solo idioma la frase se rompe:\n${s}`);
    for (const l of IDIOMAS_SOPORTADOS) {
        assert.ok(!new RegExp(`"${l}"`).test(s),
            `el código '${l}' de la máquina se ha colado en lo que se le cuenta a la clienta`);
    }
});

test('basura en el array no ensucia la lista', () => {
    const s = seccion(prompt({ idiomas: ['  klingon  ', '', null, '   ', 'sindarin'] }));
    assert.ok(/hablan klingon y sindarin\./.test(s), `no se limpió el array:\n${s}`);
});

// ─── 3 · Sin el dato NO se inventa la lista (regla 3) ───────────────────────────────

test('sin `idiomas`: se queda la prohibición y desaparece la enumeración', () => {
    for (const cfg of [{}, { idiomas: [] }, { idiomas: 'español, inglés' }, { idiomas: ['', '  '] }]) {
        const s = seccion(prompt(cfg));
        const q = JSON.stringify(cfg);
        assert.ok(s, `${q}: la sección desapareció entera — la prohibición es cierta sin datos`);
        assert.ok(/NUNCA afirmes ni des a entender que el equipo habla/.test(s),
            `${q}: se perdió la prohibición`);
        assert.ok(!/espa[ñn]ol/i.test(s) && !/ingl[ée]s/i.test(s) && !/\bruso\b/i.test(s)
            && !/ucraniano/i.test(s),
            `${q}: sin dato se ha inventado la lista de siempre:\n${s}`);
        assert.ok(!/traductor/.test(s),
            `${q}: sin lista, «se apañan con un traductor» es una promesa sin respaldo`);
    }
});

// ─── 4 · San Remo no se toca ────────────────────────────────────────────────────────

test('el prompt del restaurante no lleva nada de esto', () => {
    const p = buildSystemPrompt(SANREMO, {}, null, false, null, {
        business_info: { ...BASE, idiomas: ['klingon'] }, services: [], tone: 'cercano',
    });
    assert.ok(!/IDIOMAS DEL SAL[ÓO]N/.test(p), 'se ha colado en San Remo');
    assert.ok(!/klingon/.test(p), 'se ha colado el dato en San Remo');
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
