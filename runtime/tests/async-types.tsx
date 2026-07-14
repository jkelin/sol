import {
  $component,
  $context,
  Await,
  ErrorBoundary,
  Head,
  Suspense,
  hydrate,
  renderToStringAsync,
  type Context,
  type RenderToStringOptions,
} from "solix";

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
    <>
      <Head>
        <title>Typed head</title>
        <meta name="description" content="Typed description" />
      </Head>
      <shared.Provider data={{ count: 0, label: "provided" }}>
        <ErrorBoundary fallback={(error: unknown) => <p>{String(error)}</p>}>
          <Suspense
            fallback={<p>Loading</p>}
            error={(error: unknown) => <p>{String(error)}</p>}
            timeoutMs={100}
          >
            <AsyncChild />
            <Await $promise={promise}>{(data) => <p>{data.text}</p>}</Await>
          </Suspense>
        </ErrorBoundary>
      </shared.Provider>
    </>
  );
});

void Valid;

const options: RenderToStringOptions = { timeoutMs: 100 };
const rendered: Promise<string> = renderToStringAsync(Valid, undefined, options);
const hydrated: Promise<() => void> = hydrate(Valid, document.body);
void rendered;
void hydrated;

// @ts-expect-error Provider data must match the context shape.
const InvalidProvider = <shared.Provider data={{ label: "missing count" }} />;

// @ts-expect-error Await requires a promise-like value.
const InvalidAwait = <Await $promise={{ text: "not a promise" }}>{(data) => <p>{data}</p>}</Await>;

// @ts-expect-error Head accepts children but no convenience properties.
const InvalidHead = <Head title="Invalid" />;

void InvalidProvider;
void InvalidAwait;
void InvalidHead;
