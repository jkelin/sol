import { describe, expect, mock, test } from "bun:test";

await mock.module("virtual:sol/routes", () => ({ default: [] }));
await mock.module("@soljs/sol", () => ({ $component: (setup: unknown) => setup }));

const { badgeClass } = await import("../src/components/ui/Badge.tsx");
const { buttonClass } = await import("../src/components/ui/Button.tsx");
const { panelClass } = await import("../src/components/ui/Callout.tsx");

describe("component-owned variants", () => {
  test("builds valid component recipes", () => {
    expect(buttonClass("solar", "sm")).toContain("bg-solar");
    expect(badgeClass("cobalt")).toContain("bg-cobalt");
    expect(panelClass("mint", true)).toContain("shadow-block");
  });

  test("rejects invalid externally supplied values", () => {
    expect(() => buttonClass("ghost" as never)).toThrow("Button variant must be one of");
    expect(() => buttonClass("primary", "xl" as never)).toThrow("Button size must be one of");
    expect(() => badgeClass("violet" as never)).toThrow("Badge tone must be one of");
    expect(() => panelClass("glass" as never)).toThrow("Panel tone must be one of");
  });
});
