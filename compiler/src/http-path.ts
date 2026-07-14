export function canonicalHttpRoutePath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("HTTP route paths must start with exactly one slash");
  }
  if (path.includes("?") || path.includes("#")) {
    throw new TypeError("HTTP route paths must not contain a query or hash");
  }
  if (path.includes("\\")) throw new TypeError("HTTP route paths must not contain backslashes");
  if (path !== "/" && (path.endsWith("/") || path.includes("//"))) {
    throw new TypeError("HTTP route paths must not contain empty or trailing segments");
  }
  const names = new Set<string>();
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
          throw new TypeError(`Invalid HTTP route parameter ${segment}`);
        }
        if (names.has(name)) throw new TypeError(`Duplicate HTTP route parameter ${name}`);
        names.add(name);
        return segment;
      }
      if (segment === "." || segment === "..") {
        throw new TypeError("HTTP route paths must not contain dot segments");
      }
      if (segment.includes("%")) {
        throw new TypeError("HTTP route paths must use decoded static characters");
      }
      return segment.normalize("NFC");
    });
  return new URL(`http://solix/${segments.join("/")}`).pathname;
}
