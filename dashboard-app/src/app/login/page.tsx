"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { usernameToEmail } from "@/lib/auth-email";

type State = "idle" | "loading" | "error";

const isDev = process.env.NODE_ENV === "development";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>("idle");
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setState("loading");
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (error) {
      setState("error");
      return;
    }
    // Recarga completa para que el middleware (proxy.ts) vea la sesión en cookies.
    window.location.href = "/";
  }

  return (
    <div className="min-h-svh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Acceder al panel</h1>
          <p className="text-[13px] text-muted-foreground">
            Introduce tu usuario y contraseña.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Usuario"
            autoComplete="username"
            autoCapitalize="none"
            required
            disabled={state === "loading"}
            className="w-full h-10 rounded-md border border-input bg-transparent px-3 text-[13.5px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-shadow disabled:opacity-50"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Contraseña"
            autoComplete="current-password"
            required
            disabled={state === "loading"}
            className="w-full h-10 rounded-md border border-input bg-transparent px-3 text-[13.5px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-shadow disabled:opacity-50"
          />
          {state === "error" && (
            <p className="text-[12px] text-destructive">
              Usuario o contraseña incorrectos.
            </p>
          )}
          <button
            type="submit"
            disabled={state === "loading"}
            className="w-full h-10 rounded-md bg-primary text-primary-foreground text-[13.5px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {state === "loading" ? "Accediendo…" : "Entrar"}
          </button>
        </form>

        {isDev && (
          <div className="space-y-2 rounded-lg border border-dashed border-amber-500/50 bg-amber-500/5 p-4">
            <p className="text-[11px] font-medium text-amber-600 uppercase tracking-wider text-center">
              Dev login
            </p>
            <div className="flex gap-2">
              <a
                href="/api/dev-login?org=sante"
                className="flex-1 h-9 inline-flex items-center justify-center rounded-md bg-amber-600 text-white text-[12.5px] font-medium hover:bg-amber-700 transition-colors"
              >
                Sante
              </a>
              <a
                href="/api/dev-login?org=sanremo"
                className="flex-1 h-9 inline-flex items-center justify-center rounded-md bg-amber-600 text-white text-[12.5px] font-medium hover:bg-amber-700 transition-colors"
              >
                San Remo
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
