/** Return the message ID only for an explicitly outbound Baileys event key. */
export function outboundDeliveryMessageId(key: unknown): string | null {
  if (!key || typeof key !== 'object') return null;
  const candidate = key as { id?: unknown; fromMe?: unknown };
  if (candidate.fromMe !== true || typeof candidate.id !== 'string') return null;
  const id = candidate.id.trim();
  return id || null;
}
