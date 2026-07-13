import { $component, $context, Await, ErrorBoundary, Suspense, type Context } from "solix";

interface SharedData {
  count: number;
  label: string;
}

const shared: Context<SharedData> = $context<SharedData>();

const AsyncChild = $component(async function AsyncChild() {
  const data: SharedData = shared.use();
  const optional: SharedData | undefined = shared.useOptional();
  void optional;
  await Promise.resolve();
  return <p>{data.label}</p>;
});

const promise = Promise.resolve({ text: "ready" });

const Valid = $component(function Valid() {
  return (
    <shared.Provider data={{ count: 0, label: "provided" }}>
      <ErrorBoundary fallback={(error: unknown) => <p>{String(error)}</p>}>
        <Suspense fallback={<p>Loading</p>} error={(error: unknown) => <p>{String(error)}</p>}>
          <AsyncChild />
          <Await $promise={promise}>{(data) => <p>{data.text}</p>}</Await>
        </Suspense>
      </ErrorBoundary>
    </shared.Provider>
  );
});

void Valid;

// @ts-expect-error Provider data must match the context shape.
const InvalidProvider = <shared.Provider data={{ label: "missing count" }} />;

// @ts-expect-error Await requires a promise-like value.
const InvalidAwait = <Await $promise={{ text: "not a promise" }}>{(data) => <p>{data}</p>}</Await>;

void InvalidProvider;
void InvalidAwait;
