"use client";

import { useEffect, useState } from "react";
import {
  MODEL_FAVORITES_STORAGE_KEY,
  readFavoriteModels,
  toggleFavoriteModel,
  writeFavoriteModels,
  type FavoriteModel,
} from "@/lib/model-favorites";

const FAVORITES_CHANGED_EVENT = "pi-model-favorites-changed";

/** Share favorites across all model pickers in this window and other windows. */
export function useModelFavorites() {
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);

  useEffect(() => {
    setFavorites(readFavoriteModels());
    const onChange = (event: Event) => {
      setFavorites((event as CustomEvent<FavoriteModel[]>).detail);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === MODEL_FAVORITES_STORAGE_KEY || event.key === null) {
        setFavorites(readFavoriteModels());
      }
    };
    window.addEventListener(FAVORITES_CHANGED_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(FAVORITES_CHANGED_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const toggleFavorite = (model: FavoriteModel) => {
    const next = toggleFavoriteModel(favorites, model);
    writeFavoriteModels(next);
    // The native storage event only reaches other windows, not this one.
    window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT, { detail: next }));
  };

  return { favorites, toggleFavorite };
}
