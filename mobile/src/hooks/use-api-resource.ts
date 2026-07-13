import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api";

export function useApiResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await apiJson<T>(path)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong."); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, refresh: load };
}

export async function postForm<T>(path: string, values: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.append(key, value);
  return apiJson<T>(path, { method: "POST", body });
}
