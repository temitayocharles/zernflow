"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Field } from "@/lib/product/forms";
export type RecordData = {
  id: string;
  version: number;
  [key: string]: unknown;
};
export type ReferenceOptions = Record<string, { id: string; label: string }[]>;
export function RecordForm({
  fields,
  endpoint,
  record,
  options = {},
  redirectBase,
}: {
  fields: Field[];
  endpoint: string;
  record?: RecordData;
  options?: ReferenceOptions;
  redirectBase: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      if (
        record &&
        field.key === "contact_id" &&
        endpoint.includes("customer_profiles")
      )
        continue;
      const raw = String(form.get(field.key) ?? "");
      if (!record && !raw && !field.required) continue;
      body[field.key] =
        field.key === "enabled"
          ? raw === "true"
          : field.key.endsWith("_id") || field.type === "datetime-local"
            ? raw
              ? field.type === "datetime-local"
                ? new Date(`${raw}Z`).toISOString()
                : raw
              : null
            : field.type === "number"
              ? Number(raw)
              : raw;
    }
    if (record) body.version = record.version;
    try {
      const response = await fetch(endpoint + (record ? `/${record.id}` : ""), {
        method: record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Save failed");
      if (!record)
        router.push(
          ["/api/v1/work-queues", "/api/v1/canned-replies"].includes(endpoint)
            ? redirectBase
            : `${redirectBase}/${data.id}`,
        );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }
  const cls =
    "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-xl border border-border p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => {
          const value = record?.[field.key];
          const initial =
            value == null
              ? ""
              : field.type === "datetime-local"
                ? new Date(String(value)).toISOString().slice(0, 16)
                : String(value);
          const disabled =
            !!record &&
            field.key === "contact_id" &&
            endpoint.includes("customer_profiles");
          return (
            <label
              key={field.key}
              className={
                field.type === "textarea" ? "text-sm sm:col-span-2" : "text-sm"
              }
            >
              {field.label}
              {field.type === "datetime-local" ? " (UTC)" : ""}
              {field.reference ? (
                <select
                  name={field.key}
                  defaultValue={initial}
                  required={field.required}
                  disabled={disabled}
                  className={cls}
                >
                  <option value="">None</option>
                  {initial &&
                    !(options[field.reference] ?? []).some(
                      (o) => o.id === initial,
                    ) && (
                      <option value={initial}>
                        Current reference: {initial}
                      </option>
                    )}
                  {(options[field.reference] ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "select" ? (
                <select
                  name={field.key}
                  defaultValue={initial || field.choices?.[0]}
                  className={cls}
                >
                  {field.choices?.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  required={field.required}
                  name={field.key}
                  defaultValue={initial}
                  maxLength={10000}
                  rows={3}
                  className={cls}
                />
              ) : (
                <input
                  name={field.key}
                  type={field.type ?? "text"}
                  defaultValue={initial}
                  required={field.required}
                  min={field.type === "number" ? 0 : undefined}
                  max={field.max}
                  step={field.type === "number" ? 1 : undefined}
                  maxLength={field.key === "domain" ? 253 : 200}
                  className={cls}
                />
              )}
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <button
            type="button"
            onClick={() => router.refresh()}
            className="underline"
          >
            Reload
          </button>
        </p>
      )}
      <button
        disabled={saving}
        className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
      >
        {saving ? "Saving…" : record ? "Save changes" : "Create"}
      </button>
    </form>
  );
}
