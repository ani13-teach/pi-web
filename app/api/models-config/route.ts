import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { syncEnabledModelsWithModelsConfig } from "@/lib/enabled-models-sync";
import { invalidateModelsCache } from "@/lib/models-cache";
import { AuthModelConfigError, loadCandidateAuthModelRuntime, loadGlobalModelSettings } from "@/lib/auth-model-catalog";
import { getDesktopModelSelections, isRecord, planAuthModelEnabledPatterns, validateAuthModelOverrides, validateAuthModelSelections } from "@/lib/auth-model-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(readModelsConfig());
}

// Serialize desktop saves so two provider-list edits cannot lose each other's
// metadata while SDK validation is awaiting IO. External CLI writes still use
// the SDK's own per-file locking for settings.json.
let saveTail: Promise<unknown> = Promise.resolve();

export function PUT(req: Request) {
  const save = saveTail.then(() => saveModelsConfig(req));
  saveTail = save.catch(() => undefined);
  return save;
}

function customProviderSignature(config: Record<string, unknown>): string {
  if (!isRecord(config.providers)) return "{}";
  return JSON.stringify(Object.fromEntries(Object.entries(config.providers).flatMap(([id, provider]) => {
    if (!isRecord(provider)) return [[id, provider]];
    const fields = Object.fromEntries(Object.entries(provider).filter(([key]) => key !== "modelOverrides"));
    return Object.keys(fields).length ? [[id, fields]] : [];
  })));
}

async function saveModelsConfig(req: Request) {
  let configSaved = false;
  try {
    const body: unknown = await req.json();
    if (!isRecord(body)) throw new AuthModelConfigError("Model configuration must be an object");
    const envelope = Object.hasOwn(body, "config");
    const input = envelope ? body.config : body;
    if (!isRecord(input)) throw new AuthModelConfigError("config must be an object");
    const previous = readModelsConfig();
    const config = structuredClone(input);
    // Only the persisted marker can request a retry; UI drafts may be stale.
    delete config.desktopModelSyncPending;
    const managed = getDesktopModelSelections(previous);
    // A legacy form omitting desktop metadata must not erase explicit lists.
    const submitted = !envelope && Object.hasOwn(config, "desktopModelSelections") ? config.desktopModelSelections : {};
    if (!isRecord(submitted)) throw new AuthModelConfigError("desktopModelSelections must be an object");
    const changes: Record<string, unknown> = Object.fromEntries(Object.entries(submitted).filter(([id, ids]) => (
      JSON.stringify(ids) !== JSON.stringify(managed[id])
    )));
    if (envelope && Object.hasOwn(body, "authModelSelections")) {
      if (!isRecord(body.authModelSelections)) throw new AuthModelConfigError("authModelSelections must be an object");
      Object.assign(changes, body.authModelSelections);
    }
    // Envelope config is the complete UI draft, not an override-field patch.
    // In particular an omitted contextWindow means reset to the catalog default;
    // merging the old override here would resurrect fields the user deleted.
    // Other fields (headers, maxTokens, etc.) are preserved by the submitted draft.
    // Metadata has no meaning to the SDK, but it must still accept this extra
    // top-level property. The isolated tests exercise that real SDK boundary.
    config.desktopModelSelections = { ...managed, ...changes };
    if (Object.keys(config.desktopModelSelections as object).length === 0 && !Object.hasOwn(previous, "desktopModelSelections")) delete config.desktopModelSelections;
    const runtime = await loadCandidateAuthModelRuntime(config);
    const catalog = runtime.getModels();
    let selections;
    try {
      selections = validateAuthModelSelections(changes, catalog);
      validateAuthModelOverrides(config, previous, catalog);
    } catch (error) {
      throw new AuthModelConfigError(error instanceof Error ? error.message : "Invalid auth model settings");
    }
    config.desktopModelSelections = { ...managed, ...selections };
    if (Object.keys(config.desktopModelSelections as object).length === 0 && !Object.hasOwn(previous, "desktopModelSelections")) delete config.desktopModelSelections;
    const edited = Object.keys(selections).length > 0;
    // Preflight settings read and compute the complete rewrite BEFORE either file
    // changes. SettingsManager's locked field merge preserves unrelated settings.
    const settings = edited ? loadGlobalModelSettings() : undefined;
    const current = settings?.getGlobalSettings().enabledModels ?? [];
    const patterns = edited ? await planAuthModelEnabledPatterns(current, selections, catalog, managed) : undefined;
    // An envelope editing only auth contexts must not trigger legacy custom-model
    // cleanup of completely unrelated enabledModels entries.
    const customDefinitionsChanged = customProviderSignature(config) !== customProviderSignature(previous);
    const needsCustomSync = !envelope || customDefinitionsChanged || previous.desktopModelSyncPending === true;
    // Persist the obligation before either settings write. A partial save must
    // still reconcile custom definitions when the identical envelope is retried.
    if (needsCustomSync) config.desktopModelSyncPending = true;
    writeModelsConfig(config);
    configSaved = true;
    if (settings && patterns) {
      settings.setEnabledModels(patterns);
      await settings.flush();
      if (settings.drainErrors().length) throw new Error("settings write failed");
      invalidateModelsCache();
    }
    const enabledModelsSync = needsCustomSync
      ? await syncEnabledModelsWithModelsConfig()
      : { status: "unchanged" as const, added: [], removed: [] };
    if (enabledModelsSync.status === "skipped" && /failed|could not/.test(enabledModelsSync.reason ?? "")) {
      throw new Error("settings sync failed");
    }
    if (needsCustomSync) {
      delete config.desktopModelSyncPending;
      // If this atomic write fails the on-disk marker survives, and the response
      // remains a partial failure rather than claiming the retry is complete.
      writeModelsConfig(config);
    }
    if (patterns) {
      // Report the net change across the explicit list rewrite and custom sync.
      // The reconciler respects managed providers, so hidden models stay hidden.
      const finalPatterns = [...patterns.filter((p) => !enabledModelsSync.removed.includes(p)), ...enabledModelsSync.added];
      const added = finalPatterns.filter((p) => !current.includes(p));
      const removed = current.filter((p) => !finalPatterns.includes(p));
      return NextResponse.json({ success: true, enabledModelsSync: {
        ...enabledModelsSync,
        status: added.length || removed.length ? "updated" : enabledModelsSync.status,
        added,
        removed,
      } });
    }
    return NextResponse.json({ success: true, enabledModelsSync });
  } catch (error) {
    const partial = configSaved;
    return NextResponse.json({
      error: partial
        ? "models.json was saved, but settings.json could not be updated. The explicit desktop selections remain saved; retry to synchronize settings."
        : error instanceof AuthModelConfigError ? error.message : "Model settings could not be saved; no configuration was changed",
      ...(partial ? { partialSave: true, saved: ["config"] } : {}),
    }, { status: partial ? 500 : error instanceof AuthModelConfigError ? error.status : 500 });
  }
}
