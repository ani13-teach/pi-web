import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MODEL_FAVORITES_STORAGE_KEY,
  modelFavoriteKey,
  readFavoriteModels,
  writeFavoriteModels,
  toggleFavoriteModel,
} = await jiti.import("./model-favorites.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function withWindow(windowValue, callback) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (windowValue === undefined) delete globalThis.window;
  else Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowValue,
  });

  try {
    callback();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
}

test("models with the same name and modelId remain independent across providers", () => {
  const first = { provider: "provider-a", modelId: "shared-model", name: "Shared model" };
  const second = { provider: "provider-b", modelId: "shared-model", name: "Shared model" };
  assert.notEqual(modelFavoriteKey(first), modelFavoriteKey(second));

  const favorites = toggleFavoriteModel(toggleFavoriteModel([], first), second);
  assert.deepEqual(favorites, [
    { provider: "provider-a", modelId: "shared-model" },
    { provider: "provider-b", modelId: "shared-model" },
  ]);
  assert.deepEqual(toggleFavoriteModel(favorites, first), [favorites[1]]);
  const storage = createStorage();
  writeFavoriteModels(favorites, storage);
  assert.deepEqual(readFavoriteModels(storage), favorites);
});

test("identity keys do not collide when providers and IDs contain separators", () => {
  const models = [
    { provider: "a:b", modelId: "c" },
    { provider: "a", modelId: "b:c" },
    { provider: "a/b", modelId: "c" },
    { provider: "a", modelId: "b/c" },
    { provider: "a|b", modelId: "c" },
    { provider: "a", modelId: "b|c" },
    { provider: 'a","b', modelId: "c" },
    { provider: "a", modelId: 'b","c' },
  ];
  assert.equal(new Set(models.map(modelFavoriteKey)).size, models.length);
  const favorites = models.reduce(toggleFavoriteModel, []);
  assert.deepEqual(favorites, models);
  const storage = createStorage();
  writeFavoriteModels(favorites, storage);
  assert.deepEqual(readFavoriteModels(storage), models);
});

test("adding and removing favorites never mutate the input array or model", () => {
  const existing = Object.freeze({ provider: "provider-a", modelId: "model-a" });
  const incoming = Object.freeze({ provider: "provider-b", modelId: "model-b", name: "Model B" });
  const original = Object.freeze([existing]);
  const added = toggleFavoriteModel(original, incoming);
  assert.notStrictEqual(added, original);
  assert.deepEqual(original, [existing]);
  assert.deepEqual(added, [existing, { provider: "provider-b", modelId: "model-b" }]);
  assert.notStrictEqual(added[1], incoming);

  Object.freeze(added[1]);
  Object.freeze(added);
  const removed = toggleFavoriteModel(added, incoming);
  assert.notStrictEqual(removed, added);
  assert.deepEqual(removed, [existing]);
  assert.equal(added.length, 2);
  assert.deepEqual(toggleFavoriteModel(original, existing), []);
  assert.deepEqual(original, [existing]);
});

test("favorites round-trip under the declared storage key, including clearing", () => {
  assert.equal(MODEL_FAVORITES_STORAGE_KEY, "pi-model-favorites");
  const storage = createStorage();
  const favorites = [
    { provider: "provider-a", modelId: "model-a" },
    { provider: "provider-b", modelId: "model-b" },
  ];
  writeFavoriteModels(favorites, storage);
  assert.equal(storage.values.size, 1);
  assert.deepEqual(JSON.parse(storage.values.get(MODEL_FAVORITES_STORAGE_KEY)), favorites);
  assert.deepEqual(readFavoriteModels(storage), favorites);
  writeFavoriteModels([], storage);
  assert.equal(storage.values.get(MODEL_FAVORITES_STORAGE_KEY), "[]");
  assert.deepEqual(readFavoriteModels(storage), []);
});

test("reading deduplicates identities, filters dirty fields, and strips extra fields", () => {
  const first = { provider: "provider-a", modelId: "model-a" };
  const second = { provider: "provider-b", modelId: "model-a" };
  const raw = [
    first,
    { ...first, name: "Duplicate" },
    null,
    false,
    42,
    "model-a",
    [],
    {},
    { provider: "", modelId: "model-a" },
    { provider: "provider-a", modelId: "" },
    { provider: 123, modelId: "model-a" },
    { provider: "provider-a", modelId: false },
    { provider: null, modelId: "model-a" },
    { provider: "provider-a", modelId: null },
    { provider: "provider-a" },
    { modelId: "model-a" },
    { ...second, name: "Display only", available: false },
  ];
  const storage = createStorage({ [MODEL_FAVORITES_STORAGE_KEY]: JSON.stringify(raw) });
  assert.deepEqual(readFavoriteModels(storage), [first, second]);
});

test("missing values, bad JSON, and non-array JSON fall back to an empty list", () => {
  assert.deepEqual(readFavoriteModels(createStorage()), []);
  for (const raw of ["", "{broken", "null", "{}", '"model"', "42", "true"]) {
    const storage = createStorage({ [MODEL_FAVORITES_STORAGE_KEY]: raw });
    assert.deepEqual(readFavoriteModels(storage), [], `unexpected result for ${raw}`);
  }
});

test("explicitly unavailable storage and throwing reads or writes never crash", () => {
  const favorites = [{ provider: "provider-a", modelId: "model-a" }];
  const throwingStorage = {
    getItem() { throw new Error("read blocked"); },
    setItem() { throw new Error("write blocked"); },
  };
  assert.deepEqual(readFavoriteModels(null), []);
  assert.doesNotThrow(() => writeFavoriteModels(favorites, null));
  assert.deepEqual(readFavoriteModels(throwingStorage), []);
  assert.doesNotThrow(() => writeFavoriteModels(favorites, throwingStorage));
  assert.deepEqual(favorites, [{ provider: "provider-a", modelId: "model-a" }]);
});

test("default storage safely handles the absence of window", () => {
  withWindow(undefined, () => {
    assert.equal(typeof window, "undefined");
    assert.deepEqual(readFavoriteModels(), []);
    assert.doesNotThrow(() => writeFavoriteModels([{ provider: "p", modelId: "m" }]));
  });
});

test("default storage safely handles blocked window.localStorage access", () => {
  const blockedWindow = {};
  Object.defineProperty(blockedWindow, "localStorage", {
    get() { throw new DOMException("blocked", "SecurityError"); },
  });
  withWindow(blockedWindow, () => {
    assert.deepEqual(readFavoriteModels(), []);
    assert.doesNotThrow(() => writeFavoriteModels([{ provider: "p", modelId: "m" }]));
  });
});

test("default browser storage round-trips and handles storage operation errors", () => {
  const storage = createStorage();
  const favorites = [{ provider: "p", modelId: "m" }];
  withWindow({ localStorage: storage }, () => {
    writeFavoriteModels(favorites);
    assert.deepEqual(readFavoriteModels(), favorites);
  });
  withWindow({ localStorage: {
    getItem() { throw new Error("read blocked"); },
    setItem() { throw new Error("quota exceeded"); },
  } }, () => {
    assert.deepEqual(readFavoriteModels(), []);
    assert.doesNotThrow(() => writeFavoriteModels(favorites));
  });
});

test("storage preserves temporarily unavailable favorites across reads and unrelated toggles", () => {
  const unavailable = { provider: "temporarily-offline", modelId: "retired-from-current-list" };
  const available = { provider: "online", modelId: "current-model" };
  const storage = createStorage({
    [MODEL_FAVORITES_STORAGE_KEY]: JSON.stringify([unavailable, available]),
  });
  const stored = storage.values.get(MODEL_FAVORITES_STORAGE_KEY);
  const favorites = readFavoriteModels(storage);
  assert.deepEqual(favorites, [unavailable, available]);
  assert.equal(storage.values.get(MODEL_FAVORITES_STORAGE_KEY), stored);

  const remaining = toggleFavoriteModel(favorites, available);
  writeFavoriteModels(remaining, storage);
  assert.deepEqual(readFavoriteModels(storage), [unavailable]);
  const restored = toggleFavoriteModel(readFavoriteModels(storage), available);
  writeFavoriteModels(restored, storage);
  assert.deepEqual(readFavoriteModels(storage), [unavailable, available]);
});
