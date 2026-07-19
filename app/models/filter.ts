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

/**
 * Case-insensitive filter over model, provider, and connection labels, ranked so a query naming a
 * CONNECTION surfaces that connection's rows first. Catalog order is connection order, and slugs
 * overlap across providers — OpenRouter's catalog carries codex-slug models, so typing "codex"
 * used to put OpenRouter's look-alikes at the top (and under the keyboard's Enter) while the
 * user's actual Codex-subscription rows sat below the fold. A provider/connection-label match now
 * outranks a match on the model fields alone; ties keep catalog order (Array.sort is stable).
 */
export function filterModels<T extends FilterableModel>(
  models: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const scored: { model: T; rank: number }[] = [];
  for (const model of models) {
    const connectionMatch = [model.providerName, model.connectionLabel].some(
      (value) => value?.toLowerCase().includes(q),
    );
    const modelMatch = [model.id, model.name, model.upstreamModelId].some(
      (value) => value?.toLowerCase().includes(q),
    );
    if (!connectionMatch && !modelMatch) continue;
    scored.push({ model, rank: connectionMatch ? 0 : 1 });
  }
  return scored.sort((a, b) => a.rank - b.rank).map((entry) => entry.model);
}
