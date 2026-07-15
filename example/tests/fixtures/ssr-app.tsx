import { $component, renderToStringAsync, Suspense } from "@soljs/sol";

interface TestRuntime {
  solPrimaryLoad?: () => Promise<string>;
  solTimedLoad?: () => Promise<string>;
}

function runtime(): typeof globalThis & TestRuntime {
  return globalThis as typeof globalThis & TestRuntime;
}

const Primary = $component(async function Primary() {
  const value = await runtime().solPrimaryLoad!();
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
  const value = await runtime().solTimedLoad!();
  return <p id="ssr-timed-ready">{value}</p>;
});

export const SsrApp = $component(function SsrApp() {
  let dynamicInvalid = "invalid";
  let boundInvalid = "invalid";
  let dynamicMissing = "missing";
  let boundMissing = "missing";
  return (
    <main>
      <Suspense fallback={<p>Loading primary</p>}>
        <Primary />
      </Suspense>
      <Suspense fallback={<p id="ssr-timed-fallback">Timed fallback</p>} timeoutMs={0}>
        <Timed />
      </Suspense>
      <section id="sanitized-controls">
        <input id="dynamic-number" type="number" value={dynamicInvalid} />
        <input id="dynamic-date" type="date" value={dynamicInvalid} />
        <input id="dynamic-color" type="color" value={dynamicInvalid} />
        <input id="dynamic-range" type="range" value={dynamicInvalid} />
        <input id="bound-number" type="number" $bind={boundInvalid} />
        <input id="bound-date" type="date" $bind={boundInvalid} />
        <input id="bound-color" type="color" $bind={boundInvalid} />
        <input id="bound-range" type="range" $bind={boundInvalid} />
        <select id="dynamic-select" value={dynamicMissing}>
          <option value="first">First</option>
          <option value="second">Second</option>
        </select>
        <select id="bound-select" $bind={boundMissing}>
          <option value="first">First</option>
          <option value="second">Second</option>
        </select>
      </section>
    </main>
  );
});

export async function serverHtml(): Promise<string> {
  runtime().solPrimaryLoad = () => Promise.resolve("server data");
  runtime().solTimedLoad = () => new Promise(() => undefined);
  return renderToStringAsync(SsrApp, undefined, { timeoutMs: 100 });
}
