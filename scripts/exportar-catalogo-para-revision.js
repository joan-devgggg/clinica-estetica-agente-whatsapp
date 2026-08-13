/**
 * exportar-catalogo-para-revision.js — el catálogo en un .xlsx para que lo edite la dueña.
 *
 * Uso:  node scripts/exportar-catalogo-para-revision.js            (sante por defecto)
 *       node scripts/exportar-catalogo-para-revision.js sanremo
 *
 * SOLO LECTURA sobre Supabase: lee `agent_configs.services` y `appointments`, y no escribe
 * ni una fila. Lo único que crea es el fichero .xlsx en data/.
 *
 * Por qué un fichero y no una pantalla: la dueña trabaja en Windows y quiere renombrar y
 * repreciar el catálogo entero de una sentada. El fichero se lo lleva, lo edita y vuelve.
 *
 * Las tres decisiones que tiene el fichero dentro, y que no son cosméticas:
 *
 *   1. LA CLAVE ES EL PAR (Categoría, Nombre actual), NO el nombre solo. En el catálogo real
 *      "Corto", "Medio" y "Largo" existen CUATRO veces cada uno con cuatro precios distintos
 *      (Alisado vegano 210 / Anti-encrespamiento 120 / Deco Total Blond 125 / Mechas Airtouch
 *      195). Casar el fichero devuelto por `Nombre actual` a secas metería el precio de una
 *      categoría en otra. Por eso las DOS columnas van bloqueadas, no solo la del nombre.
 *
 *   2. LAS CITAS SE CUENTAN RESOLVIENDO, no buscando texto. `appointments.service` guarda
 *      nombres unidos por " + " y algunos servicios llevan ese separador DENTRO del nombre
 *      ("Manicura + gel"). Se usan `splitServiceNames` + `findCatalogEntriesExact`, las
 *      mismas de la facturación: si aquí se contara distinto que allí, el aviso de "no
 *      renombres esto" apuntaría a otras filas que las que de verdad mueven dinero.
 *
 *   3. UN SEGMENTO QUE CASA CON VARIAS ENTRADAS SE APUNTA A TODAS y se dice. Es lo mismo que
 *      hace la facturación con `ambiguous`: repartirlo a ojo sería inventarse a cuál de los
 *      cuatro "Corto" pertenece esa cita.
 *
 * El .xlsx se escribe a mano (OOXML + zip con zlib) porque hacen falta dos cosas que la
 * librería `xlsx` del repo no sabe ESCRIBIR: el desplegable de "Fijo/Desde" (dataValidation)
 * y el bloqueo de columnas (sheetProtection). Sin desplegable la columna se llena de "fijo",
 * "FIJO", "desde 35" y deja de ser casable.
 */

require('dotenv').config();
process.env.TZ = process.env.TZ || 'Europe/Madrid';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { getAllOrgs } = require('../services/org-registry');
const db = require('../services/db');
const { splitServiceNames, findCatalogEntriesExact, isServiceActive } = require('../services/helpers');

// ─── ZIP mínimo (un .xlsx es un zip) ────────────────────────────────────────
// Nada de dependencias nuevas para esto: son 40 líneas y el formato lleva 40 años quieto.

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function zip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const comp = zlib.deflateRawSync(raw, { level: 9 });
        const crc = crc32(raw);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);          // versión necesaria
        local.writeUInt16LE(0x0800, 6);      // flag: nombres en UTF-8
        local.writeUInt16LE(8, 8);           // método: deflate
        local.writeUInt16LE(0, 10);          // hora
        local.writeUInt16LE(0x21, 12);       // fecha (1980-01-01, determinista)
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuf.copy(local, 30);
        locals.push(local, comp);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(comp.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);        // extra
        central.writeUInt16LE(0, 32);        // comentario
        central.writeUInt16LE(0, 34);        // disco
        central.writeUInt16LE(0, 36);        // atributos internos
        central.writeUInt32LE(0, 38);        // atributos externos
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);
        centrals.push(central);

        offset += local.length + comp.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

// ─── OOXML ──────────────────────────────────────────────────────────────────

const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Los caracteres de control rompen el fichero entero: Excel dice "formato no válido" y no
    // señala dónde. Un nombre de servicio pegado desde otro sitio puede traerlos.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

const col = n => {                      // 1 → A
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
    return s;
};

function celdaTexto(ref, estilo, valor) {
    if (valor === null || valor === undefined || valor === '') return `<c r="${ref}" s="${estilo}"/>`;
    return `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t xml:space="preserve">${esc(valor)}</t></is></c>`;
}

function celdaNumero(ref, estilo, valor) {
    if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) {
        return `<c r="${ref}" s="${estilo}"/>`;
    }
    return `<c r="${ref}" s="${estilo}"><v>${Number(valor)}</v></c>`;
}

// Estilos: 0 normal · 1 cabecera · 2 clave bloqueada · 3 editable texto · 4 editable precio
//          5 precio ACTUAL (referencia, bloqueado) · 6 desplegable · 7 notas · 8 título
//          9 duración (referencia, bloqueada) · 10 duración editable (solo filas nuevas)
//
// Precio actual y Duración van BLOQUEADOS a propósito: son la referencia contra la que se
// compara lo que devuelva la dueña. Si pisa un precio actual sin querer —y es fácil, están
// pegados a las columnas que sí hay que rellenar— se pierde el "antes" y ya no se sabe qué
// cambió. Mismo motivo por el que Categoría y Nombre actual están bloqueados, solo que esas
// además identifican la fila.
//
// En las filas VACÍAS del final sí se pueden escribir (estilos 4 y 10), igual que ya pasa
// con Categoría y Nombre actual: ahí no hay ninguna referencia que proteger, y bloquearlas
// dejaría el "apunta los servicios nuevos al final" del Léeme pidiendo algo imposible.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="#,##0.##&quot; €&quot;"/>
<numFmt numFmtId="165" formatCode="0&quot; min&quot;"/>
</numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F5597"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF7DC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment horizontal="center" vertical="center" wrapText="1"/><protection locked="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment vertical="center"/><protection locked="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment vertical="center"/><protection locked="0"/></xf>
<xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment horizontal="right" vertical="center"/><protection locked="0"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment horizontal="right" vertical="center"/><protection locked="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment horizontal="center" vertical="center"/><protection locked="0"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment vertical="center" wrapText="1"/><protection locked="0"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment horizontal="right" vertical="center"/><protection locked="1"/></xf>
<xf numFmtId="165" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment horizontal="right" vertical="center"/><protection locked="0"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0"/>
</styleSheet>`;

const CABECERAS = [
    'Categoría', 'Nombre actual', 'Nombre nuevo', 'Precio actual',
    'Precio nuevo', 'Duración', '¿Precio fijo o desde?', 'Notas',
];
const ANCHOS = [22, 34, 34, 12, 12, 10, 20, 62];

function hojaCatalogo(filas) {
    const ultima = filas.length + 1;
    const cols = ANCHOS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');

    const cabecera = `<row r="1" ht="30" customHeight="1">${
        CABECERAS.map((t, i) => celdaTexto(`${col(i + 1)}1`, 1, t)).join('')
    }</row>`;

    const cuerpo = filas.map((f, i) => {
        const r = i + 2;
        // En las filas vacías del final las columnas clave van DESBLOQUEADAS: son para
        // apuntar servicios nuevos, y con el bloqueo puesto el Léeme pediría algo imposible.
        // Por lo mismo se abren ahí Precio actual y Duración, que en las filas de verdad son
        // referencia bloqueada: en una fila vacía no hay ningún "antes" que proteger.
        const clave = f.nueva ? 3 : 2;
        const precioRef = f.nueva ? 4 : 5;
        const duracionRef = f.nueva ? 10 : 9;
        return `<row r="${r}" ht="28" customHeight="1">${[
            celdaTexto(`A${r}`, clave, f.categoria),
            celdaTexto(`B${r}`, clave, f.nombre),
            celdaTexto(`C${r}`, 3, null),
            celdaNumero(`D${r}`, precioRef, f.precio),
            celdaNumero(`E${r}`, 4, null),
            celdaNumero(`F${r}`, duracionRef, f.duracion),
            celdaTexto(`G${r}`, 6, null),
            celdaTexto(`H${r}`, 7, f.notas),
        ].join('')}</row>`;
    }).join('');

    // El orden de los elementos NO es libre (lo fija el esquema): cols, sheetData,
    // sheetProtection, autoFilter, dataValidations, pageMargins.
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:H${ultima}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="C2" sqref="C2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${cabecera}${cuerpo}</sheetData>
<sheetProtection sheet="1" objects="1" scenarios="1" formatCells="0" formatColumns="0" formatRows="0" sort="0" autoFilter="0" selectLockedCells="0" selectUnlockedCells="0"/>
<autoFilter ref="A1:H${ultima}"/>
<dataValidations count="1">
<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="stop" errorTitle="Solo Fijo o Desde" error="Elige una de las dos opciones del desplegable: Fijo o Desde." promptTitle="Precio fijo o desde" prompt="Fijo = el precio no cambia en el salón. Desde = puede subir según lo que se añada." sqref="G2:G${ultima}"><formula1>"Fijo,Desde"</formula1></dataValidation>
</dataValidations>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function hojaLeeme(lineas) {
    const filas = lineas.map((t, i) => {
        const r = i + 1;
        if (t === null) return `<row r="${r}"/>`;
        const estilo = i === 0 ? 8 : 0;
        return `<row r="${r}">${celdaTexto(`A${r}`, estilo, t)}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:A${lineas.length}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="118" customWidth="1"/></cols>
<sheetData>${filas}</sheetData>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function construirXlsx(filas, leeme) {
    return zip([
        {
            name: '[Content_Types].xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
        },
        {
            name: '_rels/.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
        },
        {
            name: 'xl/workbook.xml',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<sheets>
<sheet name="Catálogo" sheetId="1" r:id="rId1"/>
<sheet name="Léeme primero" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>`,
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
        },
        { name: 'xl/styles.xml', data: STYLES },
        { name: 'xl/worksheets/sheet1.xml', data: hojaCatalogo(filas) },
        { name: 'xl/worksheets/sheet2.xml', data: hojaLeeme(leeme) },
    ]);
}

// ─── Datos ──────────────────────────────────────────────────────────────────

function resolverOrg(arg) {
    const orgs = getAllOrgs();
    const q = String(arg || 'sante').toLowerCase();
    const encontrada = orgs.find(o => o.orgId === arg || o.slug === q || o.sessionId === q);
    if (!encontrada) {
        console.error(`❌ No conozco la organización "${arg}". Opciones: ${orgs.map(o => o.sessionId).join(', ')}`);
        process.exit(1);
    }
    return encontrada;
}

// Cuenta, por entrada de catálogo, cuántas citas la nombran. Devuelve también los nombres de
// cita que NO resuelven contra ninguna entrada: son renombrados anteriores que ya dejaron
// citas huérfanas, y son la prueba más concreta de por qué hay que avisar de esta columna.
function contarCitasPorEntrada(catalog, citas) {
    const porIndice = new Map();   // índice en el catálogo → { total, futuras, ambiguo }
    const huerfanos = new Map();   // nombre no resuelto → veces
    const ahora = Date.now();

    for (const cita of citas) {
        const futura = new Date(cita.starts_at).getTime() >= ahora;
        for (const nombre of splitServiceNames(cita.service, catalog)) {
            const entradas = findCatalogEntriesExact(nombre, catalog);
            if (!entradas.length) {
                huerfanos.set(nombre, (huerfanos.get(nombre) || 0) + 1);
                continue;
            }
            for (const entrada of entradas) {
                const i = catalog.indexOf(entrada);
                const acc = porIndice.get(i) || { total: 0, futuras: 0, ambiguo: false };
                acc.total += 1;
                if (futura) acc.futuras += 1;
                if (entradas.length > 1) acc.ambiguo = true;
                porIndice.set(i, acc);
            }
        }
    }
    return { porIndice, huerfanos };
}

function componerNotas(svc, catalog, uso) {
    const notas = [];

    if (uso && uso.total > 0) {
        const futuras = uso.futuras ? `, ${uso.futuras} sin hacer todavía` : '';
        notas.push(`⚠️ ${uso.total} cita${uso.total === 1 ? '' : 's'} apuntada${uso.total === 1 ? '' : 's'}${futuras}: si le cambias el nombre, hay que cambiárselo también a esas citas o su importe se pierde en Facturación.`);
        if (uso.ambiguo) notas.push('(alguna de esas citas se llama igual en otra categoría y no se puede saber cuál era: cuéntalas como aviso, no como cifra exacta)');
    } else {
        notas.push('Sin citas apuntadas: renombrarlo no arrastra nada.');
    }

    const homonimos = catalog.filter(s => s.nombre === svc.nombre);
    if (homonimos.length > 1) {
        const cats = homonimos.map(s => s.categoria).join(', ');
        notas.push(`«${svc.nombre}» se repite en ${homonimos.length} categorías (${cats}): lo que lo identifica es la pareja categoría + nombre.`);
    }

    if (svc.precio === null || svc.precio === undefined) {
        notas.push('Hoy no tiene precio: el bot dice que se confirma en el salón.');
    }
    if (!isServiceActive(svc)) {
        notas.push('Dado de baja: el bot ya no lo ofrece (pero sigue haciendo falta para las citas viejas).');
    }

    return notas.join(' ');
}

const LEEME = [
    'Cómo rellenar este fichero',
    null,
    'Solo hay que tocar cuatro columnas. Las otras cuatro están bloqueadas: son para que sepas de qué',
    'servicio estamos hablando, y si Excel no te deja escribir en ellas es a propósito.',
    null,
    'Nombre nuevo      Escríbelo solo si le cambias el nombre. Si te vale el de ahora, déjalo en blanco.',
    'Precio nuevo      Igual: solo si cambia. En blanco = se queda como está.',
    '¿Precio fijo o desde?   Elige en el desplegable. Es la columna que más falta hace (mira abajo).',
    'Notas             Puedes escribir lo que quieras: dudas, "este lo quitamos", "preguntar a Yulia"...',
    null,
    'Por qué están bloqueadas las otras cuatro',
    null,
    'Categoría y Nombre actual son la pareja con la que localizamos cada servicio cuando nos devuelvas',
    'el fichero. Si se tocan, no sabemos a cuál te referías: "Corto" existe cuatro veces con cuatro',
    'precios distintos, y lo único que los distingue es la categoría.',
    null,
    'Precio actual y Duración son la foto de cómo está hoy. Es contra eso contra lo que comparamos lo',
    'que escribas en Precio nuevo, así que si se pisan sin querer se pierde el "antes" y ya no se sabe',
    'qué cambió. Para cambiar un precio no hay que tocar el viejo: se escribe el nuevo al lado.',
    null,
    'Fijo o desde: para qué sirve',
    null,
    'Hoy el bot dice el precio como cifra cerrada: "Manicura + gel, 35 €". Si luego en el salón hay que',
    'añadir fortalecimiento, son 5 € más y la clienta ya tenía otro número en la cabeza.',
    null,
    'Marca DESDE en los servicios donde el precio final puede subir según lo que se acabe haciendo, y FIJO',
    'en los que se cobran siempre igual. Con "desde 35 €" no hay discusión en el mostrador.',
    null,
    'En caso de duda, marca DESDE: decir "desde" y luego cobrar justo eso no molesta a nadie; decir un',
    'precio cerrado y luego cobrar más, sí.',
    null,
    'La columna Notas',
    null,
    'Lo que sale ahí ya escrito lo hemos puesto nosotros. Lo importante son los servicios que llevan un',
    'aviso ⚠️: esos tienen citas ya apuntadas con ese nombre. Renombrarlos se puede, pero hay que hacerlo',
    'con cuidado desde aquí para que las citas viejas no se queden colgadas.',
    null,
    'Los servicios que dicen "sin citas apuntadas" se pueden renombrar sin más.',
    null,
    'Cosas prácticas',
    null,
    '· No borres filas. Si un servicio ya no lo hacéis, escríbelo en Notas ("quitar") y lo damos de baja.',
    '· Si falta un servicio nuevo, apúntalo al final del todo, en las filas vacías, con su categoría.',
    '· Guárdalo como .xlsx de siempre (no como CSV) y devuélvenoslo tal cual.',
    '· Los precios, escríbelos solo con el número: 35 (no "35 euros"). Los céntimos, con coma: 37,50.',
    '· La hoja está protegida solo para que no se toquen las dos columnas clave. No tiene contraseña:',
    '  si necesitas desbloquearla, es Revisar → Desproteger hoja.',
];

async function main() {
    const org = resolverOrg(process.argv[2]);
    console.log(`\n📋 Catálogo de ${org.sessionId} (${org.orgId})\n`);

    const cfg = await db.getAgentConfig(org.orgId);
    const catalog = Array.isArray(cfg?.services) ? cfg.services : [];
    if (!catalog.length) {
        console.error('❌ El catálogo vino vacío. No se escribe nada: un fichero de 0 filas parecería un catálogo vacío.');
        process.exit(1);
    }

    // Rango deliberadamente absurdo: queremos TODA la historia. Esta lectura ya deja fuera lo
    // cancelado, los no-show y los bloqueos de agenda (`no_facturable`), que es justo lo que
    // no queremos contar como "cita apuntada".
    const citas = await db.getAppointmentsByDateRange(org.orgId, '2000-01-01', '2100-12-31');
    const { porIndice, huerfanos } = contarCitasPorEntrada(catalog, citas);

    const filas = catalog
        .map((svc, i) => ({ svc, i }))
        .sort((a, b) => (a.svc.categoria || '').localeCompare(b.svc.categoria || '', 'es') || a.i - b.i)
        .map(({ svc, i }) => ({
            categoria: svc.categoria || '(sin categoría)',
            nombre: svc.nombre,
            precio: svc.precio,
            duracion: svc.duracion,
            notas: componerNotas(svc, catalog, porIndice.get(i)),
        }));

    // Filas en blanco al final: si no las hay, "apúntalo al final" choca con la protección de
    // la hoja y el fichero vuelve sin los servicios nuevos.
    for (let k = 0; k < 15; k++) {
        filas.push({ categoria: '', nombre: '', precio: null, duracion: null, notas: '', nueva: true });
    }

    const fecha = new Date().toISOString().slice(0, 10);
    const destino = path.join(__dirname, '..', 'data', `catalogo-${org.sessionId}-revision-${fecha}.xlsx`);
    fs.writeFileSync(destino, construirXlsx(filas, LEEME));

    const conCitas = [...porIndice.values()].filter(u => u.total > 0).length;
    console.log(`   ${catalog.length} servicios · ${citas.length} citas leídas · ${conCitas} servicios con citas apuntadas`);
    console.log(`   ✅ ${path.relative(process.cwd(), destino)}\n`);

    if (huerfanos.size) {
        console.log('   Nombres de cita que YA no resuelven contra el catálogo (renombrados anteriores):');
        for (const [nombre, veces] of [...huerfanos.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`     · «${nombre}» ×${veces}`);
        }
        console.log('');
    }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
