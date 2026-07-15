declare module "virtual:sol-docs" {
  import type { Component } from "sol";

  export interface DocNavigationItem {
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly section: string;
    readonly order: number;
  }

  export const docs: readonly DocNavigationItem[];
  export const DocsContent: Component<{ readonly slug: string }>;
}

declare module "virtual:sol-code-tokens" {
  import type { CodeLine } from "../components/ui/CodePanel.tsx";

  export const counterSource: string;
  export const listSource: string;
  export const formSource: string;
  export const counterLines: readonly CodeLine[];
  export const listLines: readonly CodeLine[];
  export const formLines: readonly CodeLine[];
}
