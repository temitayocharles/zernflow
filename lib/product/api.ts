import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE } from "@/lib/workspace";
import { InputError } from "./validation";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function productContext() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new ApiError(401, "Authentication required");
  const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  let query = supabase
    .from("workspace_members")
    .select("workspace_id,role")
    .eq("user_id", user.id);
  if (selected) query = query.eq("workspace_id", selected);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data) throw new ApiError(403, "Workspace membership required");
  return { supabase, user, workspaceId: data.workspace_id, role: data.role };
}
export function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export function failure(error: unknown) {
  if (error instanceof ApiError)
    return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError)
    return json({ error: "Invalid JSON body" }, 400);
  if (error instanceof InputError) return json({ error: error.message }, 400);
  return json({ error: "Unable to complete the request" }, 500);
}
export function databaseError(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === "23505")
    throw new ApiError(409, "This record already exists");
  if (
    error.code === "23503" ||
    error.code === "23514" ||
    error.code === "22P02"
  )
    throw new ApiError(400, "Invalid relationship or field value");
  if (error.code === "42501") throw new ApiError(403, "Permission denied");
  throw new ApiError(
    503,
    "Data is unavailable. Confirm required migrations are applied.",
  );
}

/** Bound JSON parsing before materializing user-controlled payloads. */
export async function readJson(
  request: Request,
  maxBytes = 262144,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("A JSON body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes)
        throw new ApiError(413, "Request body exceeds 256 KiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(body));
}
