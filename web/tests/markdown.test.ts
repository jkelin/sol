import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  highlightCode,
  markdownModule,
  parseDocument,
  type DocMetadata,
} from "../src/markdown/compile.ts";
import { registrySource, validateDocuments } from "../src/markdown/registry.ts";
import { compileModule, readLandingExampleSources } from "../src/markdown/vite.ts";

const file = "C:/project/docs/example.md";
const frontmatter = `---
title: Example
description: A valid documentation page.
section: Guide
order: 1
---
`;

describe("documentation frontmatter", () => {
  test("parses validated metadata and derives the slug", () => {
    expect(parseDocument(`${frontmatter}\n# Hello`, file).metadata).toEqual({
      slug: "example",
      title: "Example",
      description: "A valid documentation page.",
      section: "Guide",
      order: 1,
    });
  });

  test("rejects missing, unknown, and malformed fields", () => {
    expect(() => parseDocument("# Missing", file)).toThrow(
      `${file}:1: documentation must begin with YAML frontmatter`,
    );
    expect(() => parseDocument(frontmatter.replace("order: 1", "order: zero"), file)).toThrow(
      `${file}:5: frontmatter order must be a positive integer`,
    );
    expect(() =>
      parseDocument(frontmatter.replace("order: 1", "extra: no\norder: 1"), file),
    ).toThrow("unknown field extra");
    expect(() =>
      parseDocument(frontmatter.replace("title: Example", "title: [broken"), file),
    ).toThrow(`${file}:3: malformed YAML frontmatter`);
  });

  test("rejects duplicate slugs and order values", () => {
    const first: DocMetadata = {
      slug: "first",
      title: "First",
      description: "First page",
      section: "Guide",
      order: 1,
    };
    expect(() =>
      validateDocuments([first, { ...first }], ["first.md", "again.md"], [5, 5]),
    ).toThrow("Duplicate documentation slug first in first.md:1 and again.md:1");
    expect(() =>
      validateDocuments([first, { ...first, slug: "second" }], ["first.md", "second.md"], [5, 7]),
    ).toThrow("Duplicate documentation order 1 in first.md:5 and second.md:7");
  });
});

describe("Markdown-to-Sol compilation", () => {
  test("generates a component from prose and a validated live fence", async () => {
    const generated = await markdownModule(
      `${frontmatter}
# Hello

\`\`\`sol live preview=Demo title="Live demo"
import { $component } from "sol";
const Demo = $component(function Demo() { let count = 0; return <button onClick={() => count++}>{count}</button>; });
\`\`\``,
      file,
    );
    expect(generated.code).toContain("const __LiveExample0 = $component");
    expect(generated.code).toContain("<Demo />");
    expect(generated.code).toContain(
      'import { CodePanel, ExampleViewToggle, type ExampleMode } from "/src/components/ui/index.ts";',
    );
  });

  test("rejects raw HTML and unsupported live boundaries", async () => {
    expect(markdownModule(`${frontmatter}\n<div>unsafe</div>`, file)).rejects.toThrow(
      "raw HTML is not supported",
    );
    expect(
      markdownModule(
        `${frontmatter}\n\`\`\`sol live preview=Missing\nconst value = 1;\n\`\`\``,
        file,
      ),
    ).rejects.toThrow("does not declare preview component Missing");
    expect(
      markdownModule(
        `${frontmatter}\n\`\`\`sol live preview=Demo\nimport Demo from "./Demo.tsx";\n\`\`\``,
        file,
      ),
    ).rejects.toThrow("cannot import ./Demo.tsx");
  });

  test("rejects malformed code and mount calls", async () => {
    expect(
      markdownModule(`${frontmatter}\n\`\`\`sol live preview=Demo\nconst Demo = (\n\`\`\``, file),
    ).rejects.toThrow("invalid live Sol source");
    expect(
      markdownModule(
        `${frontmatter}\n\`\`\`sol live preview=Demo\nimport { $component, mount } from "sol";\nconst Demo = $component(function Demo() { return <p>Demo</p>; });\nmount(Demo, document.body);\n\`\`\``,
        file,
      ),
    ).rejects.toThrow("must not call mount()");
  });

  test("generates the ordered navigation registry", async () => {
    const source = await registrySource(join(import.meta.dir, ".."));
    expect(source).toContain('"slug":"getting-started"');
    expect(source).toContain('"slug":"queries-and-mutations"');
    expect(source).toContain('"slug":"api-reference"');
    expect(source).not.toContain("SKILL.md");
    expect(source.indexOf('"getting-started"')).toBeLessThan(source.indexOf('"api-reference"'));
  });

  test("emits browser-valid JavaScript for virtual development modules", async () => {
    const source = `import { $component } from "sol";
const values = [1] as const;
export const Demo = $component(function Demo() { return <p>{values[0]}</p>; });`;
    const generated = await compileModule(source, "virtual-development-module.tsx");
    expect(generated.moduleType).toBe("js");
    expect(generated.code).not.toContain(" as const");
    expect(generated.code).not.toContain("Array<");
  });

  test("pre-highlights the exact landing example modules with Shiki", async () => {
    const sources = await readLandingExampleSources(join(import.meta.dir, ".."));

    await Promise.all(
      Object.values(sources).map(async (source) => {
        const lines = await highlightCode(source, "tsx");
        expect(lines).toHaveLength(source.split("\n").length);
        expect(JSON.stringify(lines)).toContain('"color":"#');
      }),
    );

    expect(sources.counterSource).toContain("Add one");
    expect(sources.counterSource).toContain("doubled / {doubled}");
    expect(sources.listSource).toContain("DOM operation ${items.length + 1}");
    expect(sources.formSource).toContain("Enter a valid email address.");
    expect(Object.values(sources).join("\n")).not.toMatch(/\bclass(?:Names)?=/);
    expect(Object.values(sources).join("\n")).not.toMatch(
      /\$(?:rpcQuery|rpcMutation|httpRoute|query)\b|\bfetch\s*\(/,
    );
  });
});
