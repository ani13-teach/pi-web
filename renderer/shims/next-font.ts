/**
 * `next/font/google` replacement.
 *
 * Next downloads and self-hosts the font at build time. There is no Next build
 * here, so the family is requested from the local font stack and the same CSS
 * variable name is provided; nothing else in the app depends on the loader.
 */
type FontOptions = {
  subsets?: string[];
  variable?: string;
  display?: string;
  weight?: string[];
};

function googleFont(family: string, options: FontOptions = {}) {
  const variable = options.variable ?? "";
  const stack = `"${family}", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  return {
    className: `font-${family.replace(/\s+/g, "-").toLowerCase()}`,
    variable,
    style: {
      fontFamily: stack,
    },
    /** Injected by the desktop entry instead of a Next build step. */
    css: `${variable ? `${variable}: ${stack};` : ""}`,
  };
}

export const Noto_Sans_Mono = (options?: FontOptions) => googleFont("Noto Sans Mono", options);
export const JetBrains_Mono = (options?: FontOptions) => googleFont("JetBrains Mono", options);
export const Geist_Mono = (options?: FontOptions) => googleFont("Geist Mono", options);
export const IBM_Plex_Mono = (options?: FontOptions) => googleFont("IBM Plex Mono", options);
