import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import rpivTodo from "../builtin/rpiv-todo/index.ts";

export const BUILTIN_RPIV_TODO_NAME = "pi-desktop-rpiv-todo";
export const BUILTIN_RPIV_TODO_PATH = `<inline:${BUILTIN_RPIV_TODO_NAME}>`;

export function createBuiltinRpivTodoExtension(): InlineExtension {
  return { name: BUILTIN_RPIV_TODO_NAME, factory: rpivTodo };
}

function isExternalRpivTodo(path: string): boolean {
  if (path.startsWith("<inline:")) return false;
  const segments = path.replaceAll("\\", "/").toLowerCase().split("/");
  return segments.includes("rpiv-todo") &&
    (segments.includes("@juicesharp") || segments.includes("extensions"));
}

/** Only replace an enabled/loaded rpiv-todo, never install it for non-users. */
export function preferBuiltinRpivTodo(base: LoadExtensionsResult): LoadExtensionsResult {
  const hasBuiltin = base.extensions.some((extension) => extension.path === BUILTIN_RPIV_TODO_PATH);
  // A failed install must remain an error, not silently turn into an enabled
  // extension that the user did not successfully load.
  const hasOriginal = base.extensions.some((extension) => isExternalRpivTodo(extension.path));
  if (hasBuiltin && hasOriginal) {
    const duplicates = base.extensions.filter((extension) => isExternalRpivTodo(extension.path)).map((extension) => extension.path);
    return {
      ...base,
      extensions: base.extensions.filter((extension) => !isExternalRpivTodo(extension.path)),
      errors: base.errors.filter((error) => !isExternalRpivTodo(error.path) &&
        !(error.path === BUILTIN_RPIV_TODO_PATH && duplicates.some((path) => error.error.includes(path)))),
    };
  }
  // No configured original: discard the inline factory before activating tools/UI.
  return {
    ...base,
    extensions: base.extensions.filter((extension) => extension.path !== BUILTIN_RPIV_TODO_PATH),
    errors: base.errors.filter((error) => error.path !== BUILTIN_RPIV_TODO_PATH),
  };
}
