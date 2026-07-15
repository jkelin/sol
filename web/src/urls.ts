const viteBase = import.meta.env.BASE_URL ?? "/";
const deploymentBase = viteBase === "/" ? "" : viteBase.slice(0, -1);

export function siteHref(path: `/${string}`): string {
  const suffixIndex = path.search(/[?#]/);
  const pathname = suffixIndex < 0 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : path.slice(suffixIndex);
  const directoryPath = pathname === "/" ? pathname : `${pathname.replace(/\/$/, "")}/`;
  return `${deploymentBase}${directoryPath}${suffix}`;
}
