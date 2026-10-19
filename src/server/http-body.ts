// Bounded request-body reading. Rejects on declared length first, then enforces the
// cap while streaming so chunked uploads cannot buffer unbounded memory.
export async function readBodyLimited(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
