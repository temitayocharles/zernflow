"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (password.length < 12) {
      setError("Password must contain at least 12 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(
        updateError.message.includes("session")
          ? "This reset link is invalid or has expired. Request a new link."
          : updateError.message,
      );
      setLoading(false);
      return;
    }

    await supabase.auth.signOut();
    setSuccess("Password updated. Redirecting you to sign in...");
    setLoading(false);
    window.setTimeout(() => router.push("/login"), 1200);
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Image src="/logo.png" alt="ZernFlow" width={48} height={48} className="mx-auto mb-3" />
          <h1 className="text-2xl font-bold">Choose a new password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Use at least 12 characters.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1.5">
              New password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="Minimum 12 characters"
            />
          </div>

          <div>
            <label htmlFor="confirmation" className="block text-sm font-medium mb-1.5">
              Confirm new password
            </label>
            <input
              id="confirmation"
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && (
            <p className="rounded-lg border border-border bg-accent px-3 py-2 text-sm text-foreground">
              {success}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Updating password..." : "Update password"}
          </button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          <Link href="/forgot-password" className="font-medium text-foreground hover:underline">
            Request another reset link
          </Link>
        </p>
      </div>
    </div>
  );
}
