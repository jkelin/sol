import { writeLauncher } from "../adapter-utils.ts";
import type { SolkitAdapter, SolkitAdapterContext } from "../types.ts";

const launcher = `import { resolve, sep } from "node:path";
import { handle } from "./app.mjs";

const clientDirectory = resolve(import.meta.dir, "../client");
const template = await Bun.file(resolve(clientDirectory, "index.html")).text();
const port = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("PORT must be a valid TCP port");
const host = Bun.env.HOST ?? "0.0.0.0";

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const isRead = request.method === "GET" || request.method === "HEAD";
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response("Bad Request", { status: 400 }); }
    const asset = resolve(clientDirectory, "." + pathname);
    if (isRead && asset.startsWith(clientDirectory + sep)) {
      const file = Bun.file(asset);
      if (pathname !== "/" && await file.exists()) return new Response(file);
    }
    if (!isRead) return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    const accept = request.headers.get("accept") ?? "";
    const acceptsDocument = accept.includes("text/html") ||
      ((!accept || accept.includes("*/*")) && !/\\/[^/]*\\.[^/]+$/.test(pathname));
    if (!acceptsDocument) {
      return new Response("Not Found", { status: 404 });
    }
    return handle(request, { template });
  },
});
const displayHost = host.includes(":") ? \`[\${host}]\` : host;
console.log(\`Solkit listening on http://\${displayHost}:\${server.port}\`);
`;

export function bunAdapter(): SolkitAdapter {
  if (arguments.length !== 0) throw new TypeError("bunAdapter() does not accept options");
  return Object.freeze({
    name: "bun",
    write: (context: SolkitAdapterContext) => writeLauncher(context, launcher),
  });
}
