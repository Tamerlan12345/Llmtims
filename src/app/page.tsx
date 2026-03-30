"use client";

import { FormEvent, useEffect, useState } from "react";

type AuthViewState = "checking" | "idle" | "loading";

export default function HomePage() {
  const [email, setEmail] = useState("admin@cic.kz");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<AuthViewState>("checking");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    let cancelled = false;

    const verifySession = async () => {
      try {
        const response = await fetch("/api/auth/session", { method: "GET" });
        const payload = (await response.json()) as { authenticated?: boolean };
        if (!cancelled && payload.authenticated) {
          window.location.replace("/dashboard");
          return;
        }
      } catch {
        // Keep login available if session check fails.
      }

      if (!cancelled) {
        setState("idle");
      }
    };

    verifySession();
    return () => {
      cancelled = true;
    };
  }, []);

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setErrorText("Введите email и пароль.");
      return;
    }

    setErrorText("");
    setState("loading");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });

      const payload = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !payload.success) {
        setErrorText(payload.error ?? "Ошибка входа.");
        setState("idle");
        return;
      }

      window.location.replace("/dashboard");
    } catch {
      setErrorText("Сервис авторизации недоступен. Повторите попытку.");
      setState("idle");
    }
  };

  return (
    <main className="relative min-h-dvh overflow-hidden text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(248,113,113,0.32),transparent_40%),radial-gradient(circle_at_88%_8%,rgba(59,130,246,0.24),transparent_35%),linear-gradient(155deg,#14070b_0%,#09050f_48%,#04030b_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[length:22px_22px] opacity-25" />

      <section className="relative z-10 mx-auto flex min-h-dvh w-full max-w-6xl items-center justify-center px-4 py-8 sm:px-8">
        <div className="grid w-full overflow-hidden rounded-3xl border border-white/15 bg-black/35 backdrop-blur-xl lg:grid-cols-[1.15fr_1fr]">
          <div className="hidden flex-col justify-between border-r border-white/10 p-10 lg:flex">
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-rose-100/70">Pixel Office CIC</p>
              <h1 className="mt-5 text-4xl font-semibold leading-tight text-white">
                Центр командного
                <br />
                управления CIC
              </h1>
            </div>
          </div>

          <div className="p-6 sm:p-10">
            <p className="text-xs uppercase tracking-[0.3em] text-rose-100/60">Авторизация</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">Вход в Pixel Office CIC</h2>
            <p className="mt-2 text-sm text-rose-100/70">
              Используйте учетную запись администратора для доступа к панели управления.
            </p>

            {state === "checking" ? (
              <div className="mt-8 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-rose-50/80">
                Проверка сессии...
              </div>
            ) : (
              <form className="mt-8 space-y-4" onSubmit={submitLogin}>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-rose-100/65">
                    Email
                  </span>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="username"
                    className="w-full rounded-xl border border-white/15 bg-black/45 px-4 py-3 text-sm text-white outline-none transition focus:border-rose-400/65 focus:ring-2 focus:ring-rose-500/35"
                    placeholder="admin@cic.kz"
                    disabled={state === "loading"}
                  />
                </label>

                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.2em] text-rose-100/65">
                    Пароль
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-white/15 bg-black/45 px-4 py-3 text-sm text-white outline-none transition focus:border-rose-400/65 focus:ring-2 focus:ring-rose-500/35"
                    placeholder="Введите пароль"
                    disabled={state === "loading"}
                  />
                </label>

                {errorText ? (
                  <div className="rounded-xl border border-red-400/35 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                    {errorText}
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={state === "loading"}
                  className="inline-flex w-full items-center justify-center rounded-xl border border-rose-300/45 bg-gradient-to-r from-rose-600 via-red-500 to-indigo-500 px-5 py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {state === "loading" ? "Вход..." : "Войти"}
                </button>
              </form>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
