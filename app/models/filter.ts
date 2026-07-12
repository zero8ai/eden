export interface FilterableModel {
  id: string;
  name: string;
  providerName?: string;
  connectionLabel?: string;
  upstreamModelId?: string;
  provider?: string;
  connectionId?: string;
}

/** Cap large catalogs per connection so one provider can never hide every later group. */
export function limitModelsPerConnection<T extends FilterableModel>(
  models: T[],
  limit: number,
): T[] {
  const counts = new Map<string, number>();
  return models.filter((model) => {
    const group = `${model.provider ?? "unknown"}/${model.connectionId ?? model.id}`;
    const count = counts.get(group) ?? 0;
    if (count >= limit) return false;
    counts.set(group, count + 1);
    return true;
  });
}

/** Case-insensitive filter over model, provider, and connection labels. */
export function filterModels<T extends FilterableModel>(
  models: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((model) =>
    [
      model.id,
      model.name,
      model.providerName,
      model.connectionLabel,
      model.upstreamModelId,
    ].some((value) => value?.toLowerCase().includes(q)),
  );
}
