import { createClient } from "@/utils/supabase/client";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

// Cliente perezoso: se instancia en el primer uso (en el navegador), no al
// evaluar el módulo (evita instanciarlo durante el render en servidor).
let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!_supabase) _supabase = createClient();
  return _supabase;
}

// Cabeceras para el backend Express. Adjunta el access_token (JWT) de la sesión
// de Supabase Auth como Bearer; el backend lo verifica y deriva la organización
// del usuario. Ya NO se envía X-Organization-Id: la org la impone el servidor a
// partir del token, así que el cliente no puede pedir datos de otra org.
// Es async porque obtener el token de la sesión lo es. El parámetro orgId se
// mantiene por compatibilidad de firma en los call sites, pero se ignora.
export async function apiHeaders(_orgId?: string): Promise<Record<string, string>> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
