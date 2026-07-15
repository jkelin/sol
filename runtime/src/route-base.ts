let routeBase = "/";

function canonicalPercentEscapes(pathname: string): string {
  return pathname.replaceAll(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

export function configureRouteBase(base: unknown): void {
  if (
    typeof base !== "string" ||
    !base.startsWith("/") ||
    !base.endsWith("/") ||
    base.startsWith("//") ||
    base.includes("\\") ||
    base.includes("?") ||
    base.includes("#")
  ) {
    throw new TypeError("Route base must be a root-relative path ending in /");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(base);
  } catch {
    throw new TypeError("Route base contains invalid URL encoding");
  }
  const segments = decoded.slice(1, -1).split("/");
  if (
    decoded.includes("\\") ||
    (base !== "/" && segments.some((segment) => !segment || segment === "." || segment === ".."))
  ) {
    throw new TypeError("Route base must not contain empty or dot segments");
  }
  const normalized = new URL(base, "https://sol.invalid").pathname;
  if (normalized !== base) throw new TypeError("Route base must not contain dot segments");
  routeBase = canonicalPercentEscapes(base);
}

export function logicalPathname(pathname: string): string | undefined {
  pathname = canonicalPercentEscapes(pathname);
  if (routeBase === "/") return pathname;
  const prefix = routeBase.slice(0, -1);
  if (pathname === prefix || pathname === routeBase) return "/";
  if (!pathname.startsWith(routeBase)) return undefined;
  return pathname.slice(prefix.length);
}

export function deployedPath(path: string): string {
  if (routeBase === "/") return path;
  return `${routeBase.slice(0, -1)}${path}`;
}
