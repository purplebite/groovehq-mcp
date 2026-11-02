const MAX_PAGES = 100;

// Groove decides when a list ends, so a page count and a repeated cursor stop one that doesn't
export function pageGuard(label: string): (cursor: string | null) => string {
  const seen = new Set<string>();

  return cursor => {
    if (!cursor || seen.has(cursor)) throw new Error(`Groove kept returning more ${label}: stopped reading`);
    if (seen.size + 1 >= MAX_PAGES) throw new Error(`Stopped reading ${label} after ${MAX_PAGES} pages`);
    seen.add(cursor);
    return cursor;
  };
}
