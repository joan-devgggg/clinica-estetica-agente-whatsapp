/**
 * auth-email.js — Mapeo determinista username → email sintético.
 *
 * El login del dashboard pide un "usuario" simple (p. ej. "Sante"), pero Supabase
 * Auth trabaja con email. Convertimos el usuario a un email interno determinista
 * que el cliente nunca ve. Debe coincidir EXACTAMENTE con la versión TS en
 * dashboard-app/src/lib/auth-email.ts (mismo dominio, mismo normalizado).
 */

const INTERNAL_EMAIL_DOMAIN = 'crm.local';

function usernameToEmail(username) {
    const normalized = String(username || '').trim().toLowerCase();
    return `${normalized}@${INTERNAL_EMAIL_DOMAIN}`;
}

module.exports = { usernameToEmail, INTERNAL_EMAIL_DOMAIN };
