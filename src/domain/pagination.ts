// OPS-1 Option C: page sizes 25/50/100, max 100, opaque stable cursors.
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Cursor {
  /** created_at of the last row returned. */
  ts: string;
  /** id of the last row returned (deterministic tie-breaker). */
  id: string;
}

export function parsePageSize(raw: string | null): { ok: true; value: number } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, value: DEFAULT_PAGE_SIZE };
  if (!/^\d+$/.test(raw)) return { ok: false };
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) ? { ok: true, value: n } : { ok: false };
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.ts, c.id])).toString("base64url");
}

export function decodeCursor(raw: string | null): { ok: true; value: Cursor | null } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      /^[0-9a-f-]{36}$/i.test(parsed[1])
    ) {
      return { ok: true, value: { ts: parsed[0], id: parsed[1] } };
    }
  } catch {
    /* fall through */
  }
  return { ok: false };
}

/** Keyset ordering shared by memory and SQL implementations: created_at desc, id desc. */
export function compareDesc(a: Cursor, b: Cursor): number {
  const t = Date.parse(b.ts) - Date.parse(a.ts);
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function isAfterCursor(row: Cursor, cursor: Cursor): boolean {
  return compareDesc(cursor, row) < 0;
}

export function paginate<T extends Cursor>(rows: T[], limit: number, cursor: Cursor | null) {
  const sorted = [...rows].sort(compareDesc);
  const after = cursor ? sorted.filter((r) => isAfterCursor(r, cursor)) : sorted;
  const page = after.slice(0, limit);
  const hasMore = after.length > limit;
  const last = page[page.length - 1];
  return {
    data: page,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ ts: last.ts, id: last.id }) : null,
  };
}
