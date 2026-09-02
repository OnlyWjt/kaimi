"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", username, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "登录失败");
      router.replace(data.redirectTo || "/");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="km-panel mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">登录</h1>
        <p className="mt-2 text-sm text-[var(--km-fg-muted)]">
          代理用平台发给你的账号从这里进后台，登录后改店铺链接和商品零售价。
          管理员账号会进入总后台。
        </p>
      </div>
      <label className="block space-y-2">
        <span className="text-sm">用户名</span>
        <input
          className="km-input w-full"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label className="block space-y-2">
        <span className="text-sm">密码</span>
        <input
          className="km-input w-full"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button className="km-btn km-btn-primary w-full" disabled={busy}>
        {busy ? "登录中…" : "登录"}
      </button>
    </form>
  );
}
