import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readDocument, type DocMetadata } from "./compile.ts";

async function markdownFiles(root: string): Promise<string[]> {
  const directory = join(root, "src", "docs");
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(directory, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
}

export function validateDocuments(
  documents: readonly DocMetadata[],
  files: readonly string[],
  orderLines: readonly number[],
): void {
  const slugs = new Map<string, string>();
  const orders = new Map<number, { readonly file: string; readonly line: number }>();
  documents.forEach((document, index) => {
    const file = files[index]!;
    const orderLine = orderLines[index]!;
    const slugOwner = slugs.get(document.slug);
    if (slugOwner)
      throw new Error(
        `Duplicate documentation slug ${document.slug} in ${slugOwner}:1 and ${file}:1`,
      );
    const orderOwner = orders.get(document.order);
    if (orderOwner)
      throw new Error(
        `Duplicate documentation order ${document.order} in ${orderOwner.file}:${orderOwner.line} and ${file}:${orderLine}`,
      );
    slugs.set(document.slug, file);
    orders.set(document.order, { file, line: orderLine });
  });
}

export async function registrySource(root: string): Promise<string> {
  const files = await markdownFiles(root);
  const parsed = await Promise.all(files.map(readDocument));
  validateDocuments(
    parsed.map((document) => document.metadata),
    files,
    parsed.map((document) => document.orderLine),
  );
  const ordered = files
    .map((file, index) => ({ file, metadata: parsed[index]!.metadata }))
    .toSorted((left, right) => left.metadata.order - right.metadata.order);
  const imports = ordered.map(
    (document, index) =>
      `import Doc${index} from ${JSON.stringify(`/@fs/${document.file.replaceAll("\\", "/")}`)};`,
  );
  const cases = ordered.map(
    (document, index) =>
      `{props.slug === ${JSON.stringify(document.metadata.slug)} && <Doc${index} />}`,
  );
  return `import { $component } from "solix";
${imports.join("\n")}
export const docs = ${JSON.stringify(ordered.map((document) => document.metadata))} as const;
export const DocsContent = $component<{ readonly slug: string }>(function DocsContent(props) {
  const found = docs.some(document => document.slug === props.slug);
  return <>{!found && <section class="border-[3px] border-ink bg-solar p-8 shadow-block"><p class="font-mono text-xs font-bold uppercase">Uncatalogued block</p><h1 class="mt-3 font-display text-4xl uppercase">This documentation page does not exist.</h1><a class="mt-6 inline-flex border-[3px] border-ink bg-cobalt px-4 py-3 font-mono text-xs font-bold uppercase text-white shadow-block-sm" href="/docs">Return to getting started</a></section>}${cases.join("")}</>;
});`;
}
