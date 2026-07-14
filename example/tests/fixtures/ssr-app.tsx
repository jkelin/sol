import { $component, renderToStringAsync, Suspense } from "solix";

interface TestRuntime {
  solixPrimaryLoad?: () => Promise<string>;
  solixTimedLoad?: () => Promise<string>;
}

function runtime(): typeof globalThis & TestRuntime {
  return globalThis as typeof globalThis & TestRuntime;
}

const Primary = $component(async function Primary() {
  const value = await runtime().solixPrimaryLoad!();
  let clicks = 0;
  async function increment() {
    clicks = await Promise.resolve(clicks + 1);
  }
  return (
    <button id="ssr-primary" onClick={increment}>
      {value}:{clicks}
    </button>
  );
});

const Timed = $component(async function Timed() {
  const value = await runtime().solixTimedLoad!();
  return <p id="ssr-timed-ready">{value}</p>;
});

export const SsrApp = $component(function SsrApp() {
  return (
    <main>
      <Suspense fallback={<p>Loading primary</p>}>
        <Primary />
      </Suspense>
      <Suspense fallback={<p id="ssr-timed-fallback">Timed fallback</p>} timeoutMs={0}>
        <Timed />
      </Suspense>
    </main>
  );
});

export async function serverHtml(): Promise<string> {
  runtime().solixPrimaryLoad = () => Promise.resolve("server data");
  runtime().solixTimedLoad = () => new Promise(() => undefined);
  return renderToStringAsync(SsrApp, undefined, { timeoutMs: 100 });
}
