// El `texto` de un hueco, en el idioma de la clienta (helpers.formatSlotTexto).
//
// Nora Benedikte (10/08/2026, ficha en inglés y 'observed') recibió cinco veces seguidas
// «El jueves, 13 de agosto a las 10:00 con Irina» en mitad de una conversación entera en
// inglés: `addSlot` fabricaba el texto con un `toLocaleDateString('es-ES')` a secas. Ese
// texto no es cosmético — lo recitan los DOS caminos que hablan con la clienta: el prompt
// del modelo (que tiene prohibido recalcular el día) y los mensajes deterministas de
// bot.js (`salonOfferSlotsMsg` y la alternativa de «ese día no tengo hueco»).
//
// Lo que este fichero protege, por orden de lo que cuesta perderlo:
//
//   1. LA CONTENCIÓN. El cuándo de un hueco sale de `formatReminderWhen`, el mismo
//      formateador que el recordatorio de 24 h, y tiene que salir LITERAL — no «parecido».
//      Es el invariante entero: si esto tuviera su propia tabla de días se separarían en el
//      primer retoque, y el mismo miércoles se le diría de dos formas distintas a la MISMA
//      clienta (una al ofrecerle el hueco, otra al recordárselo) sin que nadie se enterase
//      hasta que ella lo notase. Por eso se afirman los siete días en los cuatro idiomas
//      uno por uno, que es donde va a fallar si falla: el acusativo ruso/ucraniano («в
//      среду», «во вторник») no lo da Intl, y una tabla paralela lo perdería en silencio.
//   2. Que un llamador sin idioma caiga a CASTELLANO, con el mismo criterio que
//      `formatReminderWhen`. Los dos caen igual a propósito: si no, un idioma sin plantilla
//      daría una frase en un idioma con la fecha dentro en otro.
//   3. Que una fecha que no se entiende devuelva **null** y no una fecha cualquiera. Quien
//      llama decide el fallback; aquí no se inventa un día (regla 3).
//   4. Que el nombre de la estilista vaya TAL CUAL está en la BD. Lo edita la dueña, y
//      declinarlo («с Ириной») sería inventarle una grafía a un dato editable.
process.env.TZ = 'Europe/Madrid';
// calendar-sante arrastra la capa db → supabase, que construye su cliente al cargar. Nada
// de este fichero llega a la red: solo se usa `_internals.addSlot`, que es puro. Mismas
// credenciales ficticias que calendar-sante-slots.test.js, para que corra en un clon limpio.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { formatSlotTexto, formatReminderWhen } = require('../services/helpers');
const { _internals } = require('../services/calendar-sante');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// La misma semana que tests/recordatorio-con-fecha.test.js, y no por casualidad: las dos
// frases se las lee la misma clienta, así que conviene poder compararlas a ojo.
const SEMANA = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];
const IDIOMAS = ['es', 'en', 'ru', 'uk'];
const IRINA = 'Irina';

// ─── 1. La contención literal, los siete días en los cuatro idiomas ──────────

test('el cuándo del hueco CONTIENE literalmente el del recordatorio (7 días × 4 idiomas)', () => {
    for (const lang of IDIOMAS) {
        for (const fecha of SEMANA) {
            const cuando = formatReminderWhen(fecha, '10:00', lang);
            const texto = formatSlotTexto(fecha, '10:00', lang, IRINA);
            assert.ok(cuando, `${lang} ${fecha}: formatReminderWhen no devolvió nada`);
            assert.ok(
                texto.includes(cuando),
                `${lang} ${fecha}: «${texto}» no contiene «${cuando}» — el hueco y el ` +
                'recordatorio han dejado de decir el día igual',
            );
        }
    }
});

// Los 28 escritos a mano. La contención de arriba prueba que las dos frases no se separan;
// esto prueba QUÉ dicen, que es lo que lee la clienta. Sin esto, una tabla equivocada en
// los dos sitios a la vez pasaría el test anterior tan campante.
const ESPERADO = {
    es: [
        'a las 10:00 del lunes 10 de agosto con Irina',
        'a las 10:00 del martes 11 de agosto con Irina',
        'a las 10:00 del miércoles 12 de agosto con Irina',
        'a las 10:00 del jueves 13 de agosto con Irina',
        'a las 10:00 del viernes 14 de agosto con Irina',
        'a las 10:00 del sábado 15 de agosto con Irina',
        'a las 10:00 del domingo 16 de agosto con Irina',
    ],
    en: [
        'at 10:00 on Monday 10 August with Irina',
        'at 10:00 on Tuesday 11 August with Irina',
        'at 10:00 on Wednesday 12 August with Irina',
        'at 10:00 on Thursday 13 August with Irina',
        'at 10:00 on Friday 14 August with Irina',
        'at 10:00 on Saturday 15 August with Irina',
        'at 10:00 on Sunday 16 August with Irina',
    ],
    ru: [
        'в 10:00 в понедельник, 10 августа с Irina',
        'в 10:00 во вторник, 11 августа с Irina',
        'в 10:00 в среду, 12 августа с Irina',
        'в 10:00 в четверг, 13 августа с Irina',
        'в 10:00 в пятницу, 14 августа с Irina',
        'в 10:00 в субботу, 15 августа с Irina',
        'в 10:00 в воскресенье, 16 августа с Irina',
    ],
    uk: [
        'о 10:00 у понеділок, 10 серпня з Irina',
        'о 10:00 у вівторок, 11 серпня з Irina',
        'о 10:00 у середу, 12 серпня з Irina',
        'о 10:00 у четвер, 13 серпня з Irina',
        'о 10:00 у пʼятницю, 14 серпня з Irina',
        'о 10:00 у суботу, 15 серпня з Irina',
        'о 10:00 у неділю, 16 серпня з Irina',
    ],
};

for (const lang of IDIOMAS) {
    test(`${lang}: los siete días, byte a byte`, () => {
        SEMANA.forEach((fecha, i) => {
            assert.strictEqual(formatSlotTexto(fecha, '10:00', lang, IRINA), ESPERADO[lang][i]);
        });
    });
}

test('ru/uk: el día va en ACUSATIVO, que es lo que Intl no da', () => {
    // Intl devuelve «среда» / «середа» (nominativo) y detrás de la preposición hace falta
    // «в среду» / «у середу». Concatenar lo de Intl escribe «в 10:00 в среда».
    assert.ok(formatSlotTexto('2026-08-12', '10:00', 'ru', IRINA).includes('в среду'));
    assert.ok(!formatSlotTexto('2026-08-12', '10:00', 'ru', IRINA).includes('в среда'));
    assert.ok(formatSlotTexto('2026-08-12', '10:00', 'uk', IRINA).includes('у середу'));
    assert.ok(!formatSlotTexto('2026-08-12', '10:00', 'uk', IRINA).includes('у середа'));
});

test('ru: el martes lleva la preposición larga «во», no «в»', () => {
    const frase = formatSlotTexto('2026-08-11', '10:00', 'ru', IRINA);
    assert.ok(frase.includes('во вторник'), frase);
    assert.ok(!/[^о]\sв вторник/.test(frase), frase);
});

// ─── 2. El prefijo de la hora y el conector: las dos palabras propias ────────

test('el prefijo de la hora es el MISMO texto fijo que precede al {{2}} de Meta', () => {
    // Las plantillas aprobadas dicen «a las / at / в / о» delante del hueco {{2}}. Si esta
    // tabla se separase de aquélla, la oferta y el recordatorio empezarían distinto.
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'es', IRINA).startsWith('a las 10:00'));
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'en', IRINA).startsWith('at 10:00'));
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'ru', IRINA).startsWith('в 10:00'));
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'uk', IRINA).startsWith('о 10:00'));
});

test('el conector de la estilista va en su idioma', () => {
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'es', IRINA).endsWith('con Irina'));
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'en', IRINA).endsWith('with Irina'));
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'ru', IRINA).endsWith('с Irina'));
    assert.ok(formatSlotTexto('2026-08-13', '10:00', 'uk', IRINA).endsWith('з Irina'));
});

test('el nombre de la estilista va TAL CUAL: no se declina un dato que edita la dueña', () => {
    // «с Ириной» sería lo correcto en ruso y aun así está mal aquí: el nombre sale de
    // stylists.name en alfabeto latino, y transliterarlo es inventarle una grafía.
    for (const nombre of ['Irina', 'Yulia-Tricóloga', 'Olga']) {
        for (const lang of IDIOMAS) {
            assert.ok(
                formatSlotTexto('2026-08-13', '10:00', lang, nombre).endsWith(` ${nombre}`),
                `${lang}/${nombre}`,
            );
        }
    }
});

// ─── 3. El fallback de idioma ────────────────────────────────────────────────

test('un llamador SIN lang cae a castellano', () => {
    const es = formatSlotTexto('2026-08-13', '10:00', 'es', IRINA);
    assert.strictEqual(formatSlotTexto('2026-08-13', '10:00', null, IRINA), es);
    assert.strictEqual(formatSlotTexto('2026-08-13', '10:00', undefined, IRINA), es);
    assert.strictEqual(formatSlotTexto('2026-08-13', '10:00', '', IRINA), es);
});

test('un idioma desconocido cae a castellano, igual que formatReminderWhen', () => {
    // El mismo criterio en las dos funciones a propósito: si cayeran distinto, una frase
    // saldría en un idioma con la fecha dentro en otro.
    for (const lang of ['de', 'fr', 'pl', 'ES', 'es-ES', 'xx']) {
        assert.strictEqual(
            formatSlotTexto('2026-08-13', '10:00', lang, IRINA),
            formatSlotTexto('2026-08-13', '10:00', 'es', IRINA),
            `lang=${lang}`,
        );
    }
});

test('la caída a castellano es la MISMA en las dos funciones', () => {
    for (const lang of [null, undefined, '', 'de', 'ES']) {
        const cuando = formatReminderWhen('2026-08-13', '10:00', lang);
        assert.ok(
            formatSlotTexto('2026-08-13', '10:00', lang, IRINA).includes(cuando),
            `lang=${lang}: las dos tablas ya no caen al mismo idioma`,
        );
    }
});

// ─── 4. Nunca se inventa un día ──────────────────────────────────────────────

test('una fecha que no se entiende devuelve null, no una fecha cualquiera', () => {
    for (const mala of ['13/08/2026', '2026-8-13', 'mañana', '', null, undefined, '2026-13-01']) {
        assert.strictEqual(formatSlotTexto(mala, '10:00', 'es', IRINA), null, String(mala));
    }
});

test('el 31 de febrero no se convierte en marzo', () => {
    // Date.UTC no valida: sin la comprobación de vuelta, '2026-02-31' saldría como 3 de marzo
    // y la clienta recibiría un hueco en un día que no existe.
    assert.strictEqual(formatSlotTexto('2026-02-31', '10:00', 'es', IRINA), null);
});

test('sin hora no hay frase', () => {
    for (const sinHora of ['', null, undefined, '   ']) {
        assert.strictEqual(formatSlotTexto('2026-08-13', sinHora, 'es', IRINA), null, String(sinHora));
    }
});

test('nunca dice «mañana»: una fecha concreta no envejece mal', () => {
    for (const lang of IDIOMAS) {
        const frase = formatSlotTexto('2026-08-13', '10:00', lang, IRINA);
        assert.ok(!/mañana|tomorrow|завтра|завтра/i.test(frase), `${lang}: ${frase}`);
    }
});

test('la fecha lleva MES: un hueco recitado dos turnos después sigue siendo cierto', () => {
    for (const lang of IDIOMAS) {
        assert.ok(
            /agosto|August|августа|серпня/.test(formatSlotTexto('2026-08-13', '10:00', lang, IRINA)),
            lang,
        );
    }
});

// ─── 5. La regresión de Nora, dicha como tal ─────────────────────────────────

test('REGRESIÓN Nora: una clienta en inglés no recibe ni una palabra en castellano', () => {
    for (const fecha of SEMANA) {
        const frase = formatSlotTexto(fecha, '10:00', 'en', IRINA);
        assert.ok(
            !/lunes|martes|miércoles|jueves|viernes|sábado|domingo|agosto|a las|del |con /.test(frase),
            `se ha colado castellano: ${frase}`,
        );
    }
});

test('REGRESIÓN Nora: el texto exacto que recibió ya no se produce en inglés', () => {
    assert.notStrictEqual(
        formatSlotTexto('2026-08-13', '10:00', 'en', IRINA),
        'el jueves, 13 de agosto a las 10:00 con Irina',
    );
    assert.strictEqual(
        formatSlotTexto('2026-08-13', '10:00', 'en', IRINA),
        'at 10:00 on Thursday 13 August with Irina',
    );
});

// ─── 6. El motor de huecos lo usa de verdad ──────────────────────────────────
//
// Lo de arriba prueba la función; esto prueba que `addSlot` la llama. Sin este bloque,
// devolver `getAvailableSlots` a su `toLocaleDateString('es-ES')` dejaría todo lo anterior
// en verde y a Nora recibiendo castellano igual.

function unSlot(lang) {
    const out = [];
    _internals.addSlot(out, '2026-08-13', 600, 'jueves', { id: 'st-1', name: IRINA }, 60, {}, lang);
    return out[0];
}

test('addSlot fabrica el `texto` en el idioma que se le pasa', () => {
    assert.strictEqual(unSlot('en').texto, 'at 10:00 on Thursday 13 August with Irina');
    assert.strictEqual(unSlot('ru').texto, 'в 10:00 в четверг, 13 августа с Irina');
    assert.strictEqual(unSlot('uk').texto, 'о 10:00 у четвер, 13 серпня з Irina');
    assert.strictEqual(unSlot('es').texto, 'a las 10:00 del jueves 13 de agosto con Irina');
});

test('addSlot sin idioma cae a castellano (scripts de verificación, sesión recién creada)', () => {
    assert.strictEqual(unSlot(null).texto, 'a las 10:00 del jueves 13 de agosto con Irina');
    assert.strictEqual(unSlot(undefined).texto, 'a las 10:00 del jueves 13 de agosto con Irina');
});

test('addSlot no toca el resto del hueco: fecha, hora y estilista siguen siendo datos', () => {
    // El texto es para la clienta; lo que se reserva sale de estos campos. Si el idioma
    // tocara alguno, un hueco elegido en inglés reservaría otra cosa.
    for (const lang of [...IDIOMAS, null]) {
        const s = unSlot(lang);
        assert.strictEqual(s.fecha, '2026-08-13');
        assert.strictEqual(s.hora, '10:00');
        assert.strictEqual(s.stylistId, 'st-1');
        assert.strictEqual(s.stylistName, IRINA);
    }
});

test('un hueco NUNCA se queda sin texto: fecha ilegible degrada a castellano, no a vacío', () => {
    // dateStr lo fabrica addDaysStr y siempre es YYYY-MM-DD, así que en producción no
    // dispara. Si algún día dispara, sale el texto de siempre y no un hueco mudo que el
    // prompt recitaría como «undefined» (regla 3: se degrada, y se degrada a algo cierto).
    const out = [];
    _internals.addSlot(out, 'no-es-una-fecha', 600, 'jueves', { id: 'st-1', name: IRINA }, 60, {}, 'en');
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].texto && out[0].texto.includes('10:00'), out[0].texto);
    assert.ok(out[0].texto.includes(IRINA), out[0].texto);
});

// ─── 7. El día no se mueve con el huso del servidor ──────────────────────────

test('el día no depende de la zona horaria de la máquina', () => {
    // Heredado de formatReminderWhen (mediodía UTC + formateo en UTC), y se afirma aquí
    // porque el hueco es lo que la clienta elige: un día corrido reserva otro día.
    const src = `
        const { formatSlotTexto } = require(${JSON.stringify(path.resolve(__dirname, '../services/helpers'))});
        process.stdout.write(formatSlotTexto('2026-08-13', '10:00', 'es', 'Irina'));
    `;
    const esperado = 'a las 10:00 del jueves 13 de agosto con Irina';
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Niue', 'America/New_York', 'Asia/Tokyo']) {
        const salida = execFileSync(process.execPath, ['-e', src], {
            env: { ...process.env, TZ: tz }, encoding: 'utf8',
        });
        assert.strictEqual(salida, esperado, `TZ=${tz}`);
    }
});

(async () => {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`ok - ${name}`); }
        catch (e) { console.error(`fail - ${name}`); console.error(e); process.exitCode = 1; }
    }
})();
