import { createCodemodeExtension, type InlineExtension } from "@earendil-works/pi-coding-agent";

/** SDK hosts opt in to the same built-in extension that the CLI loads. */
export function createDesktopCodemodeExtension(): InlineExtension {
  return {
    name: "codemode",
    builtin: true,
    replaceable: true,
    factory: createCodemodeExtension({ mode: "on" }),
  };
}

/** Do not accidentally enable this opt-in tool when retaining extension tools. */
export function applyCodemodeSelection(
  toolNames: readonly string[],
  defaultTools: readonly string[] | undefined,
): string[] {
  if (toolNames.length === 0) return [];
  const selected = toolNames.filter((name) => name !== "codemode");
  if (defaultTools?.includes("codemode")) selected.push("codemode");
  return [...new Set(selected)];
}
