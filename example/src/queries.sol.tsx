import {
  $component,
  $httpRoute,
  $mutation,
  $query,
  $route,
  $rpcMutation,
  $rpcQuery,
  Suspense,
} from "solix";
import {
  noteHttpSchema,
  notesPageSchema,
  noteTitleSchema,
  verifyNotesBackendSecret,
} from "./notes-backend.ts";

interface Note {
  id: number;
  title: string;
}

interface NotePage {
  page: number;
  revision: number;
  notes: Note[];
}

let revision = 1;
let nextNoteId = 4;
const serverNotes: Note[] = [
  { id: 1, title: "Cache one request across observers" },
  { id: 2, title: "Keep stale data visible during refetch" },
  { id: 3, title: "Let mutations trigger explicit refreshes" },
];

function delayed<T>(value: T, milliseconds = 350): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds));
}

export const fetchNotes = $rpcQuery(
  "notes",
  { schema: notesPageSchema },
  async (page): Promise<NotePage> => {
    verifyNotesBackendSecret(page);
    const start = (page - 1) * 2;
    return delayed({ page, revision, notes: serverNotes.slice(start, start + 2) });
  },
);

export const createNote = $rpcMutation(
  "create-note",
  { schema: noteTitleSchema },
  async (title): Promise<Note> => {
    verifyNotesBackendSecret(title);
    const note = { id: nextNoteId++, title };
    serverNotes.unshift(note);
    revision += 1;
    return delayed(note, 250);
  },
);

export const noteHttpRoute = $httpRoute(
  {
    method: "GET",
    path: "/api/notes/:id",
    schema: noteHttpSchema,
  },
  async ({ id }) => {
    verifyNotesBackendSecret(id);
    return Response.json(serverNotes.find((note) => note.id === id) ?? null);
  },
);

const CacheObserver = $component(function CacheObserver() {
  const shared = $query(
    {
      queryKey: ["example", "notes"],
      query: fetchNotes,
      enabled: false,
      staleTime: 5_000,
      cacheTime: 60_000,
    },
    1,
  );
  return (
    <aside class="rounded border border-rule bg-paper-inset p-4" data-testid="query-observer">
      <p class="font-mono text-[0.625rem] tracking-[0.14em] text-correction uppercase">
        Second observer
      </p>
      <p class="mt-2 text-sm text-pencil">
        Shared cache revision: <strong class="text-graphite">{shared.data?.revision ?? "—"}</strong>
      </p>
    </aside>
  );
});

const QueryPanel = $component(function QueryPanel() {
  let nextPage = 2;
  let noteSequence = 1;
  const notes = $query(
    {
      queryKey: ["example", "notes"],
      query: fetchNotes,
      staleTime: 5_000,
      cacheTime: 60_000,
      pollingInterval: 15_000,
      suspense: { initial: true, refetch: false },
    },
    1,
  );
  const creation = $mutation({ mutation: createNote });

  async function refetchPage() {
    const page = nextPage;
    nextPage = nextPage === 1 ? 2 : 1;
    await notes.refetch({ suspense: false }, page);
  }

  async function addNote() {
    await creation.mutate({}, `Mutation note ${noteSequence++}`);
    await notes.refetch({ suspense: false }, 1);
  }

  return (
    <div class="mt-6 grid gap-5 lg:grid-cols-[1fr_15rem]" data-testid="query-panel">
      <section class="rounded border border-rule-strong bg-paper p-5">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
          <div>
            <p class="font-mono text-[0.625rem] tracking-[0.14em] text-correction uppercase">
              Query cache
            </p>
            <h2 class="mt-1 font-serif text-2xl text-ink">Page {notes.data?.page ?? "—"}</h2>
          </div>
          <span class="font-mono text-xs text-pencil" aria-live="polite">
            {notes.isRefetching ? "Refetching…" : notes.isFailed ? "Failed" : "Cached"}
          </span>
        </div>
        <ul class="my-4 grid gap-2" data-testid="query-notes">
          {(notes.data?.notes ?? []).map((note) => (
            <li key={note.id} class="rounded bg-paper-inset px-3 py-2 text-sm text-graphite">
              {note.title}
            </li>
          ))}
        </ul>
        <div class="flex flex-wrap gap-3">
          <button
            class="rounded border border-graphite bg-graphite px-4 py-2 text-sm text-paper disabled:opacity-50"
            type="button"
            data-testid="query-refetch"
            disabled={notes.isFetching}
            onClick={refetchPage}
          >
            Refetch page {nextPage}
          </button>
          <button
            class="rounded border border-rule-strong bg-control px-4 py-2 text-sm text-graphite disabled:opacity-50"
            type="button"
            data-testid="query-mutate"
            disabled={creation.isMutating}
            onClick={addNote}
          >
            {creation.isMutating ? "Saving…" : "Run mutation"}
          </button>
        </div>
        {notes.lastData && (
          <p class="mt-4 font-mono text-xs text-faint" data-testid="query-last-page">
            Previous successful page: {notes.lastData.page}
          </p>
        )}
      </section>
      <div class="grid content-start gap-3">
        <CacheObserver />
        <aside class="rounded border border-rule bg-paper-inset p-4 text-sm leading-6 text-pencil">
          Polling refreshes this key every 15 seconds while the page is visible. The cache survives
          for one minute after both observers unmount.
        </aside>
      </div>
    </div>
  );
});

const QueryExamplePage = $component(function QueryExamplePage() {
  return (
    <section class="w-full px-6 sm:px-0">
      <header class="border-b border-rule-strong pb-6">
        <p class="font-mono text-xs tracking-[0.14em] text-correction uppercase">
          Async controllers
        </p>
        <h1 class="mt-2 font-serif text-4xl font-normal tracking-tight text-ink">
          Queries and mutations
        </h1>
        <p class="mt-3 max-w-2xl text-sm leading-6 text-pencil">
          The initial query uses Suspense. Later requests preserve the last successful data while
          exposing refetch and mutation state.
        </p>
      </header>
      <Suspense
        fallback={
          <p
            class="mt-6 rounded border border-rule-strong bg-paper p-8 font-mono text-sm text-pencil"
            data-testid="query-loading"
          >
            Fetching the first cached page…
          </p>
        }
        error={(error) => (
          <p class="mt-6 rounded border border-correction p-4 text-correction" role="alert">
            Query failed: {String(error)}
          </p>
        )}
      >
        <QueryPanel />
      </Suspense>
    </section>
  );
});

export const queriesRoute = $route({ path: "/queries" }, QueryExamplePage);
