/**
 * tests/lib/robustez-llm-helpers.js — La parte PURA del arnés verify:robustez:llm.
 *
 * Extraída a módulo propio (nocturno 14/08/2026) para que escale de 25 a ~100 escenarios
 * sin que las políticas queden enterradas en un script que solo se puede probar pagando
 * una corrida entera de LLM. Aquí vive lo que se puede afirmar en un test determinista:
 *
 *   · la selección de escenarios (número, rango, familia:X, idioma:Y, shard:i/n) — el
 *     shard es la pieza de la paralelización por procesos, ESCRITA y aún sin conducir
 *     contra nada real (regla de la noche);
 *   · el detector del fallback del proveedor (los cuatro idiomas de getFallbackResponse)
 *     y el corte por proveedor caído: una TANDA de degradados con ese texto no es una
 *     regresión del salón, es el LLM caído o limitando (doctrina de CLAUDE.md, hasta
 *     ahora instrucción de lectura manual — con 100 escenarios tiene que ser código);
 *   · la política de reintento del DEGRADADO suelto: la doctrina «un degradado que baila
 *     entre corridas es varianza; repetir antes de tocar nada», automatizada. Solo
 *     DEGRADADO se reintenta: BUG/SILENCIO/BUCLE/ERROR son la fila dura y un reintento
 *     los taparía en vez de señalarlos;
 *   · el resumen agrupado por familia y por idioma.
 *
 * Las familias son las cinco causas conocidas de las auditorías:
 *   A afirma-sin-respaldo · B red-ancha-que-come-el-bueno · C dato-sin-sitio-en-el-estado
 *   D idioma · E contexto-que-el-bot-no-ve · control (escenarios de contraste)
 */

// Los CUATRO textos de getFallbackResponse (salón). Si aquel cambia y este no, el corte
// deja de ver la caída: por eso el test de este módulo fija los cuatro literales.
const FALLBACK_LLM_RE = /no he podido procesar|couldn't process|не удалось обработать|не вдалося обробити/i;

function esFallbackLLM(mensajes) {
    return (mensajes || []).some(m => FALLBACK_LLM_RE.test(m || ''));
}

// Cuántos escenarios SEGUIDOS con el fallback del proveedor hacen abortar la corrida.
// 3, como el umbral transitorio de llm-health: uno o dos sueltos son varianza (los dos
// fallbacks de la segunda auditoría iban con 17 h de distancia); tres seguidos en la
// misma corrida no miden el salón, miden al proveedor.
const CORTE_PROVEEDOR_UMBRAL = 3;

class CorteProveedor {
    constructor(umbral = CORTE_PROVEEDOR_UMBRAL) { this.umbral = umbral; this.seguidos = 0; }
    /** Registra un escenario terminado. Devuelve true cuando toca ABORTAR la corrida. */
    registra(tuvoFallback) {
        this.seguidos = tuvoFallback ? this.seguidos + 1 : 0;
        return this.seguidos >= this.umbral;
    }
}

// Solo el DEGRADADO se reintenta (una vez): es el único estado cuya doctrina es «repetir
// antes de perseguir». La fila dura no se reintenta jamás — un BUG que solo sale a veces
// sigue siendo un BUG, y taparlo con una segunda tirada es perder el hallazgo.
function debeReintentar(estado) {
    return estado === 'DEGRADADO';
}

/**
 * Parsea los argumentos de selección. Acepta, combinados:
 *   7            un escenario         5-12         un rango
 *   familia:C    una familia          idioma:ru    un idioma
 *   shard:2/6    la porción 2 de 6 (1-indexada, por número de escenario módulo n)
 * Sin argumentos → todo. Devuelve null ante un token no reconocido, para que el script
 * pare con uso en vez de correr «todo» en silencio por un typo (regla 3).
 */
function parseSeleccion(args) {
    const sel = { numeros: null, familias: null, idiomas: null, shard: null };
    for (const raw of args || []) {
        const tok = String(raw).trim();
        if (!tok) continue;
        let m;
        if ((m = tok.match(/^(\d+)$/))) {
            (sel.numeros ??= new Set()).add(Number(m[1]));
        } else if ((m = tok.match(/^(\d+)-(\d+)$/))) {
            const [a, b] = [Number(m[1]), Number(m[2])];
            if (b < a) return null;
            sel.numeros ??= new Set();
            for (let i = a; i <= b; i++) sel.numeros.add(i);
        } else if ((m = tok.match(/^familia:([A-Za-z]+)$/))) {
            (sel.familias ??= new Set()).add(m[1].toUpperCase() === 'CONTROL' ? 'control' : m[1].toUpperCase());
        } else if ((m = tok.match(/^idioma:([a-z]{2})$/i))) {
            (sel.idiomas ??= new Set()).add(m[1].toLowerCase());
        } else if ((m = tok.match(/^shard:(\d+)\/(\d+)$/))) {
            const [i, n] = [Number(m[1]), Number(m[2])];
            if (i < 1 || n < 1 || i > n) return null;
            sel.shard = { i, n };
        } else {
            return null;
        }
    }
    return sel;
}

/** ¿Este escenario entra en la selección? meta = { n, familia, idioma }. */
function matchesSeleccion(sel, meta) {
    if (!sel) return true;
    if (sel.numeros && !sel.numeros.has(meta.n)) return false;
    if (sel.familias && !sel.familias.has(meta.familia || null)) return false;
    if (sel.idiomas && !sel.idiomas.has(meta.idioma || null)) return false;
    if (sel.shard && ((meta.n - 1) % sel.shard.n) !== (sel.shard.i - 1)) return false;
    return true;
}

/**
 * Resumen agrupado. results: [{ estado, familia, idioma }]. Devuelve líneas de texto
 * (una por grupo) con el total y cuántos NO están en OK — que es lo único que se busca
 * con la vista agrupada: dónde se concentra el rojo.
 */
function resumenAgrupado(results) {
    const porClave = (clave) => {
        const grupos = new Map();
        for (const r of results) {
            const k = r[clave] || '—';
            const g = grupos.get(k) || { total: 0, mal: 0 };
            g.total++;
            if (r.estado !== 'OK') g.mal++;
            grupos.set(k, g);
        }
        return [...grupos.entries()]
            .sort((a, b) => b[1].mal - a[1].mal || b[1].total - a[1].total)
            .map(([k, g]) => `  ${String(k).padEnd(8)} ${String(g.total).padStart(3)} escenario(s) · ${g.mal ? `${g.mal} con hallazgo` : 'todo OK'}`);
    };
    return {
        porFamilia: porClave('familia'),
        porIdioma: porClave('idioma'),
    };
}

module.exports = {
    FALLBACK_LLM_RE, esFallbackLLM,
    CORTE_PROVEEDOR_UMBRAL, CorteProveedor,
    debeReintentar,
    parseSeleccion, matchesSeleccion,
    resumenAgrupado,
};
