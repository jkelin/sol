import { parse as parseJavaScript } from "@babel/parser";
import type * as t from "@babel/types";
import type { Code, Content, Heading, Root } from "mdast";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { codeToTokens, type BundledLanguage } from "shiki";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

export interface DocMetadata {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly section: string;
  readonly order: number;
}

export interface ParsedDocument {
  readonly metadata: DocMetadata;
  readonly body: string;
  readonly orderLine: number;
}

interface LiveBlock {
  readonly code: string;
  readonly preview: string;
  readonly title: string;
  readonly line: number;
  readonly imports: readonly t.ImportDeclaration[];
  readonly moduleBody: string;
  readonly linesName: string;
}

interface RenderState {
  readonly file: string;
  readonly liveBlocks: LiveBlock[];
  readonly moduleDeclarations: string[];
  nextCodeBlock: number;
}

const metadataKeys = new Set(["title", "description", "section", "order"]);
const allowedExampleImports = new Set(["sol", "valibot"]);

function fail(file: string, message: string, line?: number): never {
  throw new Error(`${file}${line ? `:${line}` : ""}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function frontmatterLine(source: string, field: string): number {
  const index = source.split(/\r?\n/).findIndex((line) => new RegExp(`^${field}\\s*:`).test(line));
  return index < 0 ? 2 : index + 2;
}

function requireString(
  value: unknown,
  field: string,
  file: string,
  source: string,
  minimumLength = 1,
): string {
  if (typeof value !== "string" || value.trim().length < minimumLength) {
    return fail(
      file,
      `frontmatter ${field} must be a non-empty string`,
      frontmatterLine(source, field),
    );
  }
  return value.trim();
}

function slugFromFile(file: string): string {
  const slug = basename(file, ".md");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    fail(file, "Markdown filenames must use lowercase kebab-case");
  }
  return slug;
}

export function parseDocument(source: string, file: string): ParsedDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) fail(file, "documentation must begin with YAML frontmatter", 1);
  let candidate: unknown;
  try {
    candidate = parseYaml(match[1]!);
  } catch (error) {
    const line =
      error && typeof error === "object" && "linePos" in error
        ? ((error as { linePos?: readonly { line: number }[] }).linePos?.[0]?.line ?? 1) + 1
        : 2;
    fail(
      file,
      `malformed YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      line,
    );
  }
  if (!isRecord(candidate)) fail(file, "frontmatter must be an object", 2);
  const unexpected = Object.keys(candidate).find((key) => !metadataKeys.has(key));
  if (unexpected)
    fail(
      file,
      `frontmatter contains unknown field ${unexpected}`,
      frontmatterLine(match[1]!, unexpected),
    );
  const order = candidate.order;
  if (!Number.isInteger(order) || (order as number) < 1) {
    fail(file, "frontmatter order must be a positive integer", frontmatterLine(match[1]!, "order"));
  }
  return {
    metadata: Object.freeze({
      slug: slugFromFile(file),
      title: requireString(candidate.title, "title", file, match[1]!),
      description: requireString(candidate.description, "description", file, match[1]!),
      section: requireString(candidate.section, "section", file, match[1]!),
      order: order as number,
    }),
    body: match[2]!,
    orderLine: frontmatterLine(match[1]!, "order"),
  };
}

export async function readDocument(file: string): Promise<ParsedDocument> {
  return parseDocument(await readFile(file, "utf8"), file);
}

function textContent(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const candidate = node as { readonly children?: readonly unknown[]; readonly value?: unknown };
  if (typeof candidate.value === "string") return candidate.value;
  return candidate.children?.map((child) => textContent(child)).join("") ?? "";
}

function headingId(node: Heading): string {
  return textContent(node)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function jsxText(value: string): string {
  return `{${JSON.stringify(value)}}`;
}

function safeHref(url: string, file: string, line?: number): string {
  if (
    url.startsWith("/") ||
    url.startsWith("#") ||
    url.startsWith("https://") ||
    url.startsWith("http://") ||
    url.startsWith("mailto:")
  ) {
    return url;
  }
  return fail(file, `unsupported link URL ${url}`, line);
}

function walkAst(value: unknown, visit: (node: t.Node) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walkAst(item, visit));
    return;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.type === "string") visit(candidate as unknown as t.Node);
  for (const [key, child] of Object.entries(candidate)) {
    if (["loc", "start", "end", "extra"].includes(key)) continue;
    walkAst(child, visit);
  }
}

function parseLiveMeta(node: Code, file: string): { preview: string; title: string } {
  const meta = node.meta ?? "";
  if (!/(^|\s)live(?:\s|$)/.test(meta)) {
    fail(file, "sol code fences must include the live flag", node.position?.start.line);
  }
  const preview = /(?:^|\s)preview=([A-Za-z_$][\w$]*)/.exec(meta)?.[1];
  if (!preview) {
    fail(file, "live fences require preview=ComponentName", node.position?.start.line);
  }
  const titleMatch = /(?:^|\s)title=(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(meta);
  return { preview, title: titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3] ?? preview };
}

function parseLiveBlock(node: Code, state: RenderState): Omit<LiveBlock, "linesName"> {
  const { preview, title } = parseLiveMeta(node, state.file);
  let ast: ReturnType<typeof parseJavaScript>;
  try {
    ast = parseJavaScript(node.value, {
      sourceType: "module",
      sourceFilename: state.file,
      plugins: ["typescript", "jsx"],
    });
  } catch (error) {
    fail(
      state.file,
      `invalid live Sol source: ${error instanceof Error ? error.message : String(error)}`,
      node.position?.start.line,
    );
  }

  const imports = ast.program.body.filter(
    (statement): statement is t.ImportDeclaration => statement.type === "ImportDeclaration",
  );
  for (const declaration of imports) {
    const source = declaration.source.value;
    if (!allowedExampleImports.has(source)) {
      fail(state.file, `live examples cannot import ${source}`, node.position?.start.line);
    }
  }
  const previewDeclaration = ast.program.body.find(
    (statement) =>
      statement.type === "VariableDeclaration" &&
      statement.declarations.some(
        (declaration) => declaration.id.type === "Identifier" && declaration.id.name === preview,
      ),
  );
  if (!previewDeclaration) {
    fail(
      state.file,
      `live example does not declare preview component ${preview}`,
      node.position?.start.line,
    );
  }
  walkAst(ast.program, (candidate) => {
    if (
      candidate.type === "CallExpression" &&
      candidate.callee.type === "Identifier" &&
      candidate.callee.name === "mount"
    ) {
      fail(state.file, "live examples must not call mount()", node.position?.start.line);
    }
  });
  const ranges = imports
    .map((declaration) => [declaration.start ?? 0, declaration.end ?? 0] as const)
    .toSorted((left, right) => right[0] - left[0]);
  let moduleBody = node.value;
  for (const [start, end] of ranges)
    moduleBody = `${moduleBody.slice(0, start)}${moduleBody.slice(end)}`;
  return {
    code: node.value,
    preview,
    title,
    line: node.position?.start.line ?? 1,
    imports,
    moduleBody,
  };
}

export async function highlightCode(code: string, language: string): Promise<readonly unknown[]> {
  try {
    const languageId = (language === "sol" ? "tsx" : language) as BundledLanguage;
    const result = await codeToTokens(code, { lang: languageId, theme: "github-dark" });
    return result.tokens.map((line) => ({
      tokens: line.map((token) => ({ content: token.content, color: token.color })),
    }));
  } catch {
    return code.split("\n").map((line) => ({ tokens: [{ content: line, color: "#fffaf0" }] }));
  }
}

async function renderCode(node: Code, state: RenderState): Promise<string> {
  const index = state.nextCodeBlock++;
  const lines = await highlightCode(node.value, node.lang ?? "text");
  const linesName = `__code_lines_${index}`;
  state.moduleDeclarations.push(`const ${linesName} = ${JSON.stringify(lines)};`);
  if (node.lang === "sol") {
    const block = parseLiveBlock(node, state);
    const liveIndex = state.liveBlocks.push({ ...block, linesName }) - 1;
    return `<__LiveExample${liveIndex} />`;
  }
  const codeName = `__code_source_${index}`;
  state.moduleDeclarations.push(`const ${codeName} = ${JSON.stringify(node.value)};`);
  return `<div class="my-6"><CodePanel code={${codeName}} lines={${linesName}} filename=${JSON.stringify(node.lang ? `example.${node.lang}` : "example.txt")} /></div>`;
}

async function renderNodeAsync(node: Content, state: RenderState): Promise<string> {
  if (node.type === "code") return renderCode(node, state);
  const children = async (): Promise<string> => {
    if (!("children" in node) || !Array.isArray(node.children)) return "";
    let rendered = "";
    // oxlint-disable-next-line no-await-in-loop -- shared declaration indexes must follow source order
    for (const child of node.children) rendered += await renderNodeAsync(child as Content, state);
    return rendered;
  };
  switch (node.type) {
    case "paragraph":
      return `<p>${await children()}</p>`;
    case "heading": {
      const tag = `h${node.depth}`;
      return `<${tag} id=${JSON.stringify(headingId(node))}>${await children()}</${tag}>`;
    }
    case "emphasis":
      return `<em>${await children()}</em>`;
    case "strong":
      return `<strong>${await children()}</strong>`;
    case "delete":
      return `<del>${await children()}</del>`;
    case "link":
      return `<a href=${JSON.stringify(safeHref(node.url, state.file, node.position?.start.line))}>${await children()}</a>`;
    case "list":
      return `<${node.ordered ? "ol" : "ul"}${node.ordered && node.start && node.start !== 1 ? ` start={${node.start}}` : ""}>${await children()}</${node.ordered ? "ol" : "ul"}>`;
    case "listItem":
      return `<li>${node.checked === null || node.checked === undefined ? "" : `<span aria-hidden="true">${node.checked ? "☑" : "☐"}</span>`}${await children()}</li>`;
    case "blockquote":
      return `<blockquote>${await children()}</blockquote>`;
    case "table":
      return `<div class="my-6 overflow-x-auto"><table class="w-full border-collapse border-[3px] border-ink bg-paper">${await children()}</table></div>`;
    case "tableRow":
      return `<tr>${await children()}</tr>`;
    case "tableCell":
      return `<td class="border-2 border-ink p-3 text-left">${await children()}</td>`;
    default:
      return renderNode(node, state);
  }
}

function renderNode(node: Content, state: RenderState): string {
  switch (node.type) {
    case "text":
      return jsxText(node.value);
    case "inlineCode":
      return `<code>${jsxText(node.value)}</code>`;
    case "thematicBreak":
      return `<hr class="my-10 border-0 border-t-[3px] border-ink" />`;
    case "break":
      return `<br />`;
    case "html":
      return fail(
        state.file,
        "raw HTML is not supported in documentation",
        node.position?.start.line,
      );
    case "image":
    case "imageReference":
      return fail(
        state.file,
        "images are not supported in documentation Markdown",
        node.position?.start.line,
      );
    case "linkReference":
      return fail(state.file, "reference-style links are not supported", node.position?.start.line);
    case "code":
      return fail(
        state.file,
        "code block was not rendered asynchronously",
        node.position?.start.line,
      );
    default:
      return fail(
        state.file,
        `unsupported Markdown node ${(node as Content).type}`,
        node.position?.start.line,
      );
  }
}

function mergeImports(blocks: readonly LiveBlock[], file: string): string[] {
  const imports = new Map<string, Map<string, string>>();
  const namespaces = new Map<string, string>();
  for (const block of blocks) {
    for (const declaration of block.imports) {
      const source = declaration.source.value;
      for (const specifier of declaration.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          const existing = namespaces.get(source);
          if (existing && existing !== specifier.local.name) {
            fail(file, `live imports for ${source} use conflicting namespace names`, block.line);
          }
          namespaces.set(source, specifier.local.name);
        } else if (specifier.type === "ImportDefaultSpecifier") {
          fail(
            file,
            `default imports from ${source} are not supported in live examples`,
            block.line,
          );
        } else {
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (specifier.importKind === "type" || (source === "sol" && imported === "$component")) {
            continue;
          }
          const sourceImports = imports.get(source) ?? new Map<string, string>();
          const existing = sourceImports.get(imported);
          if (existing && existing !== specifier.local.name) {
            fail(file, `live imports for ${imported} use conflicting local names`, block.line);
          }
          sourceImports.set(imported, specifier.local.name);
          imports.set(source, sourceImports);
        }
      }
    }
  }
  const declarations: string[] = [];
  for (const [source, namespace] of namespaces) {
    if (imports.has(source))
      fail(file, `live examples cannot mix namespace and named imports from ${source}`);
    declarations.push(`import * as ${namespace} from ${JSON.stringify(source)};`);
  }
  for (const [source, names] of imports) {
    const specifiers = [...names].map(([imported, local]) =>
      imported === local ? imported : `${imported} as ${local}`,
    );
    declarations.push(`import { ${specifiers.join(", ")} } from ${JSON.stringify(source)};`);
  }
  return declarations;
}

export async function markdownModule(
  source: string,
  file: string,
): Promise<{ code: string; metadata: DocMetadata }> {
  const parsed = parseDocument(source, file);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(parsed.body) as Root;
  const state: RenderState = { file, liveBlocks: [], moduleDeclarations: [], nextCodeBlock: 0 };
  let body = "";
  // oxlint-disable-next-line no-await-in-loop -- shared live-example indexes must be deterministic
  for (const node of tree.children) body += await renderNodeAsync(node, state);
  const imports = mergeImports(state.liveBlocks, file);
  const liveSources = state.liveBlocks.map((block) => block.moduleBody).join("\n");
  const uiModule = "/src/components/ui/index.ts";
  const liveComponents = state.liveBlocks
    .map((block, index) => {
      const linesName = block.linesName;
      return `const __LiveExample${index} = $component(function __LiveExample${index}() {
  let mode = "both" as ExampleMode;
  return <section class="my-8 border-[3px] border-ink bg-paper shadow-block" data-live-example=${JSON.stringify(block.preview)}>
    <header class="flex flex-col gap-4 border-b-[3px] border-ink bg-solar p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><p class="font-mono text-[0.6875rem] font-bold uppercase text-cobalt">Live Sol / compiled</p><h3 class="mt-2 font-display text-2xl uppercase">${jsxText(block.title)}</h3></div>
      <ExampleViewToggle mode={mode} onChange={(next) => mode = next} />
    </header>
    <div classNames={["grid", { "lg:grid-cols-2": mode === "both" }]}>
      <div hidden={mode === "preview"} class="min-w-0"><CodePanel code={${JSON.stringify(block.code)}} lines={${linesName}} filename=${JSON.stringify(`${block.preview}.tsx`)} /></div>
      <div hidden={mode === "code"} class="min-h-72 bg-cream p-6 sm:p-8"><${block.preview} /></div>
    </div>
  </section>;
});`;
    })
    .join("\n");
  return {
    metadata: parsed.metadata,
    code: `import { $component, Head } from "sol";
import { CodePanel, ExampleViewToggle, type ExampleMode } from ${JSON.stringify(uiModule)};
${imports.join("\n")}
${state.moduleDeclarations.join("\n")}
${liveSources}
${liveComponents}
export const metadata = ${JSON.stringify(parsed.metadata)} as const;
const Document = $component(function Document() { return <><Head><title>${jsxText(parsed.metadata.title)}</title><meta name="description" content=${JSON.stringify(parsed.metadata.description)} /></Head><article class="docs-prose">${body}</article></>; });
export default Document;`,
  };
}
