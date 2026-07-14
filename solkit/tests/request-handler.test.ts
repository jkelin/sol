import { expect, mock, test } from "bun:test";
import {
  block,
  component,
  instantiate,
  template,
  text,
} from "../../runtime/src/compiler-runtime.ts";

await mock.module("virtual:solix/routes", () => ({ default: [] }));
const { createRequestHandler } = await import("../src/index.ts");

const definition = template(
  '<main data-solix-e="0"><!--solix:s:0--><!--solix:e:0--></main>',
  "solkit-test",
  { elements: ["main"], regions: [0], operations: [] },
);
const Root = component((_props, frame) => {
  const view = instantiate(definition, frame);
  const cleanups: Array<() => void> = [];
  text(view.regions[0]!, () => frame.url?.pathname ?? "missing", cleanups);
  return block(view.fragment, cleanups);
});

const templateHtml =
  '<!doctype html><html><head><!--solkit-head--></head><body><div id="app"><!--solkit-body--></div></body></html>';

test("renders the request URL into an SSR document and supports HEAD", async () => {
  const handle = createRequestHandler(Root);
  const response = await handle(new Request("https://example.test/articles/one"), {
    template: templateHtml,
  });
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toContain("/articles/one");

  const head = await handle(new Request("https://example.test/", { method: "HEAD" }), {
    template: templateHtml,
  });
  expect(await head.text()).toBe("");
});

test("validates request and document boundaries", async () => {
  const handle = createRequestHandler(Root);
  expect(() =>
    handle(new Request("https://example.test/", { method: "POST" }), {
      template: templateHtml,
    }),
  ).toThrow("only GET and HEAD");
  expect(() => handle(new Request("https://example.test/"), { template: "<div></div>" })).toThrow(
    "exactly once",
  );
});
