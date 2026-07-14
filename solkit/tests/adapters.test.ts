import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunAdapter } from "../src/adapters/bun.ts";
import { nodeAdapter } from "../src/adapters/node.ts";

const directories: string[] = [];
const processes: Bun.Subprocess[] = [];

async function waitForResponse(url: string, attempts = 40): Promise<Response> {
  const response = await fetch(url).catch(() => undefined);
  if (response) return response;
  if (attempts <= 1) throw new Error(`Server did not respond at ${url}`);
  await Bun.sleep(25);
  return waitForResponse(url, attempts - 1);
}

afterEach(async () => {
  for (const process of processes.splice(0)) process.kill();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

for (const [name, adapter] of [
  ["bun", bunAdapter()],
  ["node", nodeAdapter()],
] as const) {
  test(`${name} adapter writes a standalone production launcher`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `solkit-${name}-`));
    directories.push(directory);
    const serverDirectory = join(directory, "server");
    await adapter.write({ serverDirectory, clientDirectory: join(directory, "client") });
    const launcher = await readFile(join(serverDirectory, "index.mjs"), "utf8");
    expect(launcher).toContain('import { handle } from "./app.mjs"');
    expect(launcher).toContain("../client");
    expect(launcher).toContain("PORT must be a valid TCP port");
    if (name === "bun") {
      await writeFile(join(serverDirectory, "app.mjs"), "export function handle() {}");
      const checked = await Bun.build({
        entrypoints: [join(serverDirectory, "index.mjs")],
        target: "bun",
      });
      expect(checked.success).toBe(true);
    } else {
      const checked = Bun.spawnSync(["node", "--check", join(serverDirectory, "index.mjs")]);
      expect(checked.exitCode).toBe(0);
    }
    if (name === "node") {
      const nodeServerDirectory = join(directory, "node-server");
      const script = `
        import { nodeAdapter } from ${JSON.stringify(new URL("../src/adapters/node.ts", import.meta.url).href)};
        await nodeAdapter().write({
          serverDirectory: ${JSON.stringify(nodeServerDirectory)},
          clientDirectory: ${JSON.stringify(join(directory, "node-client"))},
        });
      `;
      const loadedByNode = Bun.spawnSync(["node", "--input-type=module", "--eval", script]);
      expect(loadedByNode.exitCode).toBe(0);
      expect(await readFile(join(nodeServerDirectory, "index.mjs"), "utf8")).toBe(launcher);
    }
  });
}

for (const [name, adapter, command] of [
  ["bun", bunAdapter(), "bun"],
  ["node", nodeAdapter(), "node"],
] as const) {
  test(`${name} adapter serves assets and forwards application requests`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `solkit-${name}-runtime-`));
    directories.push(directory);
    const serverDirectory = join(directory, "server");
    const clientDirectory = join(directory, "client");
    await mkdir(clientDirectory, { recursive: true });
    await adapter.write({ serverDirectory, clientDirectory });
    await writeFile(
      join(serverDirectory, "app.mjs"),
      `export async function handle(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/early") {
          await request.body?.cancel();
          return new Response("limited", { status: 413 });
        }
        if (pathname === "/stream-error") {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              setTimeout(() => controller.error(new Error("stream failed")), 10);
            },
          }));
        }
        return pathname.endsWith(".js")
          ? new Response("Not Found", { status: 404 })
          : new Response(\`SSR:\${pathname}\`);
      }`,
    );
    await writeFile(join(clientDirectory, "index.html"), "<!doctype html>");
    await writeFile(join(clientDirectory, "asset.js"), "export const value = 1;");
    const reservation = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = reservation.port;
    reservation.stop(true);
    const process = Bun.spawn([command, join(serverDirectory, "index.mjs")], {
      env: { ...Bun.env, HOST: "127.0.0.1", PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    processes.push(process);

    const documentResponse = await waitForResponse(`http://127.0.0.1:${port}/route`, 40);
    expect(await documentResponse.text()).toBe("SSR:/route");
    const asset = await fetch(`http://127.0.0.1:${port}/asset.js`);
    if (name === "node") {
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    }
    expect(await asset.text()).toContain("value = 1");
    const missingAsset = await fetch(`http://127.0.0.1:${port}/missing.js`);
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.text()).toBe("Not Found");
    const post = await fetch(`http://127.0.0.1:${port}/route`, { method: "POST" });
    expect(post.status).toBe(200);
    expect(await post.text()).toBe("SSR:/route");
    if (name === "node") {
      const early = await fetch(`http://127.0.0.1:${port}/early`, {
        method: "POST",
        body: "request body",
      });
      expect(early.status).toBe(413);
      expect(await early.text()).toBe("limited");
      const followup = await fetch(`http://127.0.0.1:${port}/after-early`);
      expect(await followup.text()).toBe("SSR:/after-early");

      const streamFailure = await fetch(`http://127.0.0.1:${port}/stream-error`)
        .then(async (response) => await response.text())
        .catch((error: unknown) => error);
      expect(streamFailure).toBeInstanceOf(Error);
    }

    process.kill();
    await process.exited;
    const output = await new Response(process.stdout).text();
    expect(output).toContain(`Solkit listening on http://127.0.0.1:${port}`);
  });
}
