export interface FavoriteModel {
  provider: string;
  modelId: string;
}

export const MODEL_FAVORITES_STORAGE_KEY = "pi-model-favorites";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function modelFavoriteKey(model: FavoriteModel): string {
  // A tuple keeps IDs containing separators distinct across providers.
  return JSON.stringify([model.provider, model.modelId]);
}

export function readFavoriteModels(storage: StorageLike | null = getBrowserStorage()): FavoriteModel[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(MODEL_FAVORITES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const favorites: FavoriteModel[] = [];
    for (const item of parsed) {
      if (!item || typeof item.provider !== "string" || !item.provider
        || typeof item.modelId !== "string" || !item.modelId) continue;
      const model = { provider: item.provider, modelId: item.modelId };
      const key = modelFavoriteKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      favorites.push(model);
    }
    return favorites;
  } catch {
    return [];
  }
}

export function writeFavoriteModels(
  favorites: FavoriteModel[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  try {
    storage?.setItem(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Storage is best-effort; the hook retains the preference for this page.
  }
}

export function toggleFavoriteModel(favorites: FavoriteModel[], model: FavoriteModel): FavoriteModel[] {
  const key = modelFavoriteKey(model);
  return favorites.some((favorite) => modelFavoriteKey(favorite) === key)
    ? favorites.filter((favorite) => modelFavoriteKey(favorite) !== key)
    : [...favorites, { provider: model.provider, modelId: model.modelId }];
}
