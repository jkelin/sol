import { expect, test } from "bun:test";
import { bunAdapter } from "../src/adapters/bun.ts";
import { solkit } from "../src/vite.ts";

test("validates Vite integration options", () => {
  expect(() => solkit({ entry: "src/app.tsx", adapter: bunAdapter() })).toThrow("root-relative");
  expect(() =>
    solkit({ entry: "/src/app.tsx", exportName: "not-valid!", adapter: bunAdapter() }),
  ).toThrow("identifier");
  expect(solkit({ entry: "/src/app.tsx", adapter: bunAdapter() }).name).toBe("solkit");
});
