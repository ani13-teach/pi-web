/** Shared wire types only: this module must remain safe for browser imports. */
export type AuthModelSelections = Record<string, string[]>;
export type AuthModelSelection = AuthModelSelections;

export interface AuthModelCatalogEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  enabled: boolean;
}

export interface AuthModelProviderCatalog {
  models: AuthModelCatalogEntry[];
  selectedIds: string[];
}

export interface AuthModelCatalog {
  providers: Record<string, AuthModelProviderCatalog>;
}

export interface AuthModelsConfigSaveRequest {
  config: Record<string, unknown>;
  /** Only providers whose selection was edited. An empty list hides that provider. */
  authModelSelections?: AuthModelSelections;
}
