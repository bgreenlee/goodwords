/**
 * Nothing stops two people choosing the same name — there are no accounts, and
 * asking for one that is "taken" would be a poor trade for a game you join by
 * typing a word. So names stay as chosen, and a short tag is added only where a
 * list actually shows a clash. Most of the time nobody sees one.
 */

function tag(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
  return `#${(hash >>> 0).toString(36).slice(-2)}`;
}

/** Display name per row id, disambiguated only where two rows share a name. */
export function labelRows<T extends { id: string; name: string }>(rows: T[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const row of rows) {
    const clashes = (seen.get(row.name.trim().toLowerCase()) ?? 0) > 1;
    labels.set(row.id, clashes ? `${row.name} ${tag(row.id)}` : row.name);
  }
  return labels;
}
