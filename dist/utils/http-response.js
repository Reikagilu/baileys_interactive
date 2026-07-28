/** Release an unused undici response body without buffering it. */
export async function discardResponseBody(response) {
    if (!response.body || response.bodyUsed)
        return;
    try {
        await response.body.cancel();
    }
    catch { /* best effort */ }
}
