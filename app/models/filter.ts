export interface FilterableModel {
  id: string;
  name: string;
}

/** Case-insensitive filter over model id + display name. */
export function filterModels<T extends FilterableModel>(
  models: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
  );
}
