/** Return the message ID only for an explicitly outbound Baileys event key. */
export function outboundDeliveryMessageId(key) {
    if (!key || typeof key !== 'object')
        return null;
    const candidate = key;
    if (candidate.fromMe !== true || typeof candidate.id !== 'string')
        return null;
    const id = candidate.id.trim();
    return id || null;
}
