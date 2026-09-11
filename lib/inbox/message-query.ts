export function parseMessageQuery(params: URLSearchParams): {
  conversationId: string;
  cursor?: string;
  limit: number;
  paginated: boolean;
} {
  const conversationId = params.get("conversationId")?.trim();
  if (!conversationId) throw new Error("conversationId required");
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && (!cursor.trim() || cursor.length > 2048)) throw new Error("Invalid message cursor");
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 200 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer between 1 and 200");
  return { conversationId, cursor, limit, paginated: params.get("paginated") === "true" };
}
