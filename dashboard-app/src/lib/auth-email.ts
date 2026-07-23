// Mapeo determinista username → email sintético para Supabase Auth.
// El usuario introduce "Sante"; internamente iniciamos sesión con el email
// resultante. Debe coincidir EXACTAMENTE con scripts/auth-email.js (mismo
// dominio y normalizado) para que el login case con el usuario creado.

export const INTERNAL_EMAIL_DOMAIN = "crm.local";

export function usernameToEmail(username: string): string {
  const normalized = (username ?? "").trim().toLowerCase();
  return `${normalized}@${INTERNAL_EMAIL_DOMAIN}`;
}
