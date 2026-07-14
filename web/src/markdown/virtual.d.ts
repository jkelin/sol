declare module "virtual:solix-docs" {
  import type { Component } from "solix";

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

declare module "virtual:solix-code-tokens" {
  import type { CodeLine } from "../components/ui/CodePanel.tsx";

  export const counterLines: readonly CodeLine[];
  export const listLines: readonly CodeLine[];
  export const formLines: readonly CodeLine[];
}
