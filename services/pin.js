/**
 * pin.js — PIN de ATRIBUCIÓN por estilista. Puro: solo `crypto`, sin BD ni red.
 *
 * Esto NO es autenticación. No autoriza nada, no bloquea el panel y no impide que alguien
 * declare mal lo que cobró. Lo único que permite es distinguir una atribución CONFIRMADA
 * (metió su PIN) de una DECLARADA (solo eligió su nombre en el desplegable).
 *
 * Dos piezas:
 *   · hash del PIN (scrypt + salt por fila) — para que no quede en claro en la BD.
 *   · un token corto firmado que dice "esta estilista metió su PIN hace poco", para no tener
 *     que teclearlo en cada cobro NI guardar el PIN en el navegador.
 */

const crypto = require('crypto');

// Formato: 4 a 6 dígitos. Ni menos (3 son 1.000 combinaciones y se adivinan mirando) ni más
// (nadie se acuerda, y un PIN que no se recuerda se acaba apuntando en un papel al lado de la
// caja, que es peor que no tenerlo).
const PIN_RE = /^\d{4,6}$/;
function isValidPinFormat(pin) { return PIN_RE.test(String(pin ?? '')); }

// scrypt viene en Node: cero dependencias nuevas.
//
// Con 4 dígitos el hash NO resiste fuerza bruta —10.000 combinaciones se prueban en un
// instante— y no pretende hacerlo. Lo que evita es que el PIN se lea a simple vista en la
// tabla, en un volcado o en un log, y que alguien lo reutilice al verlo de pasada. Para lo que
// se pide (atribución, no seguridad) con eso basta; más aparato sería justo lo descartado.
const SCRYPT_KEYLEN = 32;

function hashPin(pin) {
    if (!isValidPinFormat(pin)) throw new Error('El PIN son 4 a 6 dígitos');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pin), salt, SCRYPT_KEYLEN).toString('hex');
    return { hash, salt };
}

function verifyPin(pin, hash, salt) {
    if (!isValidPinFormat(pin) || !hash || !salt) return false;
    let calculado;
    try {
        calculado = crypto.scryptSync(String(pin), salt, SCRYPT_KEYLEN);
    } catch { return false; }
    const guardado = Buffer.from(String(hash), 'hex');
    // Longitudes distintas hacen que timingSafeEqual LANCE, así que se comprueba antes.
    if (guardado.length !== calculado.length) return false;
    return crypto.timingSafeEqual(guardado, calculado);
}

// ─── Token de atribución ────────────────────────────────────────────────────
//
// El PIN se teclea UNA vez y se cambia el token por él. El PIN nunca se guarda en el
// navegador; lo que viaja en cada cobro es este token, que solo dice quién y hasta cuándo.
//
// Firmado con HMAC y `DASHBOARD_API_SECRET`, así que el servidor no guarda sesiones: la
// caducidad va DENTRO y la valida quien la tiene que validar. Un cliente no puede alargarla
// cambiando su reloj ni editando el sessionStorage.
//
// Lleva `orgId` para que un token de una organización no valga en otra.
const TOKEN_VERSION = 'c1';

function secreto() {
    const s = process.env.DASHBOARD_API_SECRET;
    return s && String(s).length ? String(s) : null;
}

function firmar(cuerpoB64) {
    return crypto.createHmac('sha256', secreto()).update(cuerpoB64).digest('base64url');
}

// Sin secreto NO se emite un token inservible en silencio: se lanza. Una atribución que nunca
// puede confirmarse tiene que doler al configurar, no aparecer semanas después como un cierre
// entero en "declarada" que nadie sabe explicar.
function issueAttributionToken({ orgId, stylistId, minutos = 30, ahora = Date.now() }) {
    if (!secreto()) throw new Error('DASHBOARD_API_SECRET no está configurado: no se puede confirmar la atribución');
    if (!orgId || !stylistId) throw new Error('Falta org o estilista para emitir el token');
    const mins = Number(minutos);
    const ventana = Number.isFinite(mins) && mins > 0 ? mins : 30;
    const cuerpo = { v: TOKEN_VERSION, o: String(orgId), s: String(stylistId), exp: ahora + ventana * 60_000 };
    const b64 = Buffer.from(JSON.stringify(cuerpo)).toString('base64url');
    return `${b64}.${firmar(b64)}`;
}

// Devuelve { stylistId, exp } si el token es válido para esa org, o null.
// null cubre TODO lo que no es válido —ausente, mal firmado, caducado, de otra org— porque
// para el cobro las cuatro cosas significan lo mismo: no se puede confirmar, se registra como
// declarada. Quien necesite distinguirlas mira el log de quien llama.
function verifyAttributionToken(token, { orgId, ahora = Date.now() } = {}) {
    if (!token || !secreto()) return null;
    const partes = String(token).split('.');
    if (partes.length !== 2) return null;
    const [b64, firma] = partes;

    const esperada = Buffer.from(firmar(b64));
    const recibida = Buffer.from(String(firma));
    if (esperada.length !== recibida.length) return null;
    if (!crypto.timingSafeEqual(esperada, recibida)) return null;

    let cuerpo;
    try { cuerpo = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
    if (cuerpo?.v !== TOKEN_VERSION) return null;
    if (orgId && cuerpo.o !== String(orgId)) return null;
    if (!(Number(cuerpo.exp) > ahora)) return null;
    return { stylistId: cuerpo.s, exp: Number(cuerpo.exp) };
}

module.exports = {
    isValidPinFormat, hashPin, verifyPin,
    issueAttributionToken, verifyAttributionToken,
    PIN_RE, TOKEN_VERSION,
};
