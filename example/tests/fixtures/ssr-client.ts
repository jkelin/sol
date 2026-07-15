import { hydrate } from "@soljs/sol";
import { SsrApp } from "./ssr-app.tsx";

interface BrowserTestRuntime {
  solPrimaryCalls?: number;
  solPrimaryLoad?: () => Promise<string>;
  solTimedLoad?: () => Promise<string>;
  solResolveTimed?: (value: string) => void;
}

const runtime = globalThis as typeof globalThis & BrowserTestRuntime;
runtime.solPrimaryCalls = 0;
runtime.solPrimaryLoad = () => {
  runtime.solPrimaryCalls! += 1;
  return Promise.resolve("duplicate browser data");
};
runtime.solTimedLoad = () =>
  new Promise<string>((resolve) => {
    runtime.solResolveTimed = resolve;
  });

export async function startHydration(): Promise<() => void> {
  return hydrate(SsrApp, document.querySelector("#ssr-app")!);
}
