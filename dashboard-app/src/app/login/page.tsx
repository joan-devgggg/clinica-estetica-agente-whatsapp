"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";

type State = "idle" | "loading" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState("loading");
    const origin = window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/api/auth/callback` },
    });
    setState(error ? "error" : "sent");
  }

  return (
    <div className="min-h-svh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Acceder al panel</h1>
          <p className="text-[13px] text-muted-foreground">
            Te enviamos un enlace mágico a tu email.
          </p>
        </div>

        {state === "sent" ? (
          <div className="rounded-lg border border-border bg-muted/40 px-5 py-4 text-center space-y-1">
            <p className="text-[13.5px] font-medium">Revisa tu bandeja de entrada</p>
            <p className="text-[12px] text-muted-foreground">
              Hemos enviado un enlace a <span className="font-medium text-foreground">{email}</span>.
              Haz clic en él para entrar.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              required
              disabled={state === "loading"}
              className="w-full h-10 rounded-md border border-input bg-transparent px-3 text-[13.5px] placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring transition-shadow disabled:opacity-50"
            />
            {state === "error" && (
              <p className="text-[12px] text-destructive">
                No se pudo enviar el enlace. Comprueba el email e inténtalo de nuevo.
              </p>
            )}
            <button
              type="submit"
              disabled={state === "loading"}
              className="w-full h-10 rounded-md bg-primary text-primary-foreground text-[13.5px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {state === "loading" ? "Enviando…" : "Enviar enlace"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
