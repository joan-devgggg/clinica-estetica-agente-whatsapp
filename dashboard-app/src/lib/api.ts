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

// Escritura contra la API que NO puede fallar en silencio. Varias pantallas hacían
// `await fetch(...)` y a continuación `toast.success("Guardado")` sin mirar la respuesta:
// un 500, un 404 o un contacto de otra organización se veían exactamente igual que un
// guardado correcto. Lanza con el mensaje real del servidor para que el llamante muestre
// un error en vez de un éxito inventado.
export async function apiMutate(
  path: string,
  init: { method: string; body?: unknown; orgId?: string },
): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: await apiHeaders(init.orgId),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const detalle = await res
      .json()
      .then((b) => b?.error as string | undefined)
      .catch(() => undefined);
    throw new Error(detalle || `El servidor respondió ${res.status}`);
  }
  return res;
}
