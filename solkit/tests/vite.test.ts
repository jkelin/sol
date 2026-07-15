import { expect, test } from "bun:test";
import type { ResolvedConfig } from "vite";
import { bunAdapter } from "../src/adapters/bun.ts";
import { staticAdapter } from "../src/adapters/static.ts";
import { solkit } from "../src/vite.ts";

test("validates Vite integration options", () => {
  expect(() => solkit({ entry: "src/app.tsx", adapter: bunAdapter() })).toThrow("root-relative");
  expect(() =>
    solkit({ entry: "/src/app.tsx", exportName: "not-valid!", adapter: bunAdapter() }),
  ).toThrow("identifier");
  expect(() => solkit({ entry: "/src/app.tsx", adapter: bunAdapter(), maxBodyBytes: 1.5 })).toThrow(
    "maxBodyBytes",
  );
  expect(() =>
    solkit({ entry: "/src/app.tsx", adapter: { name: "bad", static: "yes", write() {} } as never }),
  ).toThrow("static marker");
  expect(solkit({ entry: "/src/app.tsx", adapter: bunAdapter() }).name).toBe("solkit");
});

test("configures the route base in dynamic server entries", () => {
  const plugin = solkit({ entry: "/src/app.tsx", adapter: bunAdapter() });
  (plugin.configResolved as (config: ResolvedConfig) => void)({ base: "/sol/" } as ResolvedConfig);

  const source = (plugin.load as (id: string) => string)("\0virtual:solkit/server");

  expect(source).toContain('import { configureRouteBase } from "sol/compiler-runtime"');
  expect(source).toContain('configureRouteBase("/sol/")');
  expect(source).toContain("logicalPaths: false");

  const staticPlugin = solkit({ entry: "/src/app.tsx", adapter: staticAdapter() });
  (staticPlugin.configResolved as (config: ResolvedConfig) => void)({
    base: "/sol/",
  } as ResolvedConfig);
  const staticSource = (staticPlugin.load as (id: string) => string)("\0virtual:solkit/server");
  expect(staticSource).toContain("logicalPaths: true");
});
