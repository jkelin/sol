import { writeLauncher } from "../adapter-utils.ts";
import type { SolkitAdapter, SolkitAdapterContext } from "../types.ts";

const launcher = `import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./app.mjs";

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const clientDirectory = resolve(serverDirectory, "../client");
const template = await readFile(resolve(clientDirectory, "index.html"), "utf8");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("PORT must be a valid TCP port");
const host = process.env.HOST ?? "0.0.0.0";
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = \`http://\${incoming.headers.host ?? "localhost"}\`;
    const url = new URL(incoming.url ?? "/", origin);
    const isRead = incoming.method === "GET" || incoming.method === "HEAD";
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { outgoing.writeHead(400).end("Bad Request"); return; }
    const asset = resolve(clientDirectory, "." + pathname);
    if (isRead && pathname !== "/" && asset.startsWith(clientDirectory + sep)) {
      try {
        const details = await stat(asset);
        if (details.isFile()) {
          const extension = asset.slice(asset.lastIndexOf(".")).toLowerCase();
          outgoing.setHeader("content-type", contentTypes.get(extension) ?? "application/octet-stream");
          createReadStream(asset).pipe(outgoing);
          return;
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (!isRead) { outgoing.writeHead(405, { allow: "GET, HEAD" }).end("Method Not Allowed"); return; }
    const accept = incoming.headers.accept ?? "";
    const acceptsDocument = accept.includes("text/html") ||
      ((!accept || accept.includes("*/*")) && !/\\/[^/]*\\.[^/]+$/.test(pathname));
    if (!acceptsDocument) {
      outgoing.writeHead(404).end("Not Found");
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request(url, { method: incoming.method, headers });
    const response = await handle(request, { template });
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (!response.body) { outgoing.end(); return; }
    for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end("Internal Server Error");
  }
});
server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  const displayHost = host.includes(":") ? \`[\${host}]\` : host;
  console.log(\`Solkit listening on http://\${displayHost}:\${listeningPort}\`);
});
`;

export function nodeAdapter(): SolkitAdapter {
  if (arguments.length !== 0) throw new TypeError("nodeAdapter() does not accept options");
  return Object.freeze({
    name: "node",
    write: (context: SolkitAdapterContext) => writeLauncher(context, launcher),
  });
}
