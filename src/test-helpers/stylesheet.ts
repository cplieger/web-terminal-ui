declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

// Vite's raw glob rather than a static `?raw` import, which would need an ambient
// `declare module "*?raw"` that the published source would ship. Vite reads the
// glob's arguments statically, so this module stays outside Stryker's `mutate`
// set, and the extensionless MANIFEST is reached by prefix because a pattern
// without magic throws inside vite:import-glob.
const MANIFESTS = import.meta.glob("../../css/MANIFEST*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHEETS = import.meta.glob("../../css/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byName = (mods: Record<string, string>): Map<string | undefined, string> =>
  new Map(Object.entries(mods).map(([p, text]) => [p.split("/").pop(), text]));

/** The stylesheet a css/ manifest concatenates, in the manifest's order, which
 *  is the cascade; throws when the manifest or a sheet it names is missing. */
export function shippedBundle(manifest: "MANIFEST" | "MANIFEST.tabbed" | "MANIFEST.touch"): string {
  const order = byName(MANIFESTS).get(manifest);
  if (order === undefined) {
    throw new Error(`css/${manifest} is missing`);
  }
  const sheets = byName(SHEETS);
  return order
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((name) => {
      const text = sheets.get(name);
      if (text === undefined) {
        throw new Error(`css/${manifest} names ${name}, which css/ does not contain`);
      }
      return text;
    })
    .join("\n");
}
