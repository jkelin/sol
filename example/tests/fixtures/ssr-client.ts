import { hydrate } from "solix";
import { SsrApp } from "./ssr-app.tsx";

interface BrowserTestRuntime {
  solixPrimaryCalls?: number;
  solixPrimaryLoad?: () => Promise<string>;
  solixTimedLoad?: () => Promise<string>;
  solixResolveTimed?: (value: string) => void;
}

const runtime = globalThis as typeof globalThis & BrowserTestRuntime;
runtime.solixPrimaryCalls = 0;
runtime.solixPrimaryLoad = () => {
  runtime.solixPrimaryCalls! += 1;
  return Promise.resolve("duplicate browser data");
};
runtime.solixTimedLoad = () =>
  new Promise<string>((resolve) => {
    runtime.solixResolveTimed = resolve;
  });

export async function startHydration(): Promise<() => void> {
  return hydrate(SsrApp, document.querySelector("#ssr-app")!);
}
