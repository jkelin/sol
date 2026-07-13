import { $component } from "frontend-framework";

type Filter = "all" | "active" | "completed";

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

interface TodoRowProps {
  todo: Todo;
  onRemove: () => void;
  onRename: (title: string) => void;
}

export const componentSetupCounts = { app: 0, row: 0 };

declare global {
  interface Window {
    frontendFrameworkDemo?: typeof componentSetupCounts;
  }
}

window.frontendFrameworkDemo = componentSetupCounts;

const TodoRow = $component(function TodoRow(props: TodoRowProps) {
  componentSetupCounts.row += 1;
  let editing = false;
  let editDraft = props.todo.title;

  function beginEditing(event: MouseEvent) {
    editDraft = props.todo.title;
    editing = true;
    const row = (event.currentTarget as HTMLElement).closest(".todo-row");
    queueMicrotask(() => {
      const editor = row?.querySelector<HTMLInputElement>(".todo-editor");
      editor?.focus();
      editor?.select();
    });
  }

  function finishEditing(event?: FocusEvent) {
    if (event && (!editing || !(event.currentTarget as HTMLInputElement).isConnected)) return;
    const title = editDraft.trim();
    if (title) props.onRename(title);
    else editDraft = props.todo.title;
    editing = false;
  }

  function cancelEditing() {
    editDraft = props.todo.title;
    editing = false;
  }

  function handleEditKey(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      finishEditing();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    }
  }

  return (
    <li
      classNames={[
        "todo-row group grid min-h-14 grid-cols-[2.125rem_1fr_auto] items-center gap-2.5 px-6 sm:px-11",
        { "bg-paper-inset/60": editing },
      ]}
      data-testid={`todo-${props.todo.id}`}
    >
      <label class="relative grid size-5.5 place-items-center">
        <input
          class="peer absolute m-0 size-5.5 cursor-pointer appearance-none rounded-xs border border-pencil/60 bg-paper/80 checked:border-completion focus-visible:outline-3 focus-visible:outline-focus/50"
          type="checkbox"
          $bind={props.todo.completed}
          aria-label={`Mark ${props.todo.title} as ${props.todo.completed ? "active" : "completed"}`}
        />
        <span
          class="pointer-events-none z-1 -translate-y-px -rotate-6 font-serif text-xl leading-none text-completion opacity-0 peer-checked:opacity-100"
          aria-hidden="true"
        >
          ✓
        </span>
      </label>
      <input
        class="todo-editor w-full min-w-0 rounded-xs border border-rule-strong bg-paper-inset px-2.5 py-1.5 font-serif text-[1.0625rem] text-graphite shadow-[inset_0_-1px_var(--color-rule)] focus-visible:outline-3 focus-visible:outline-focus/50"
        $bind={editDraft}
        aria-label={`Edit ${props.todo.title}`}
        hidden={!editing}
        onBlur={finishEditing}
        onKeyDown={handleEditKey}
      />
      <button
        classNames={[
          "w-fit cursor-text bg-transparent px-0.5 py-1 text-left font-serif text-[1.0625rem] hover:underline hover:decoration-rule-strong hover:underline-offset-4",
          { "text-faint line-through decoration-correction": props.todo.completed },
        ]}
        type="button"
        hidden={editing}
        onClick={beginEditing}
        aria-label={`Edit ${props.todo.title}`}
      >
        {props.todo.title}
      </button>
      <button
        class="text-xs text-correction underline decoration-transparent underline-offset-3 opacity-100 transition-opacity hover:decoration-current sm:opacity-0 sm:group-hover:opacity-100"
        type="button"
        onClick={props.onRemove}
        aria-label={`Remove ${props.todo.title}`}
      >
        Remove
      </button>
    </li>
  );
});

export const App = $component(function App() {
  componentSetupCounts.app += 1;
  let draft = "";
  let filter = "all" as Filter;
  let todos: Todo[] = [
    { id: 1, title: "Trace the first compiled template", completed: true },
    { id: 2, title: "Prove nested proxy updates", completed: false },
    { id: 3, title: "Ship without a virtual DOM", completed: false },
  ];
  let nextId = 4;

  const filteredTodos =
    filter === "active"
      ? todos.filter((todo) => !todo.completed)
      : filter === "completed"
        ? todos.filter((todo) => todo.completed)
        : todos;
  const remaining = todos.filter((todo) => !todo.completed).length;
  const completed = todos.length - remaining;
  const canAdd = draft.trim().length > 0;

  function addTodo(event: SubmitEvent) {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    todos.push({ id: nextId++, title, completed: false });
    draft = "";
  }

  function removeTodo(id: number) {
    const index = todos.findIndex((todo) => todo.id === id);
    if (index >= 0) todos.splice(index, 1);
  }

  function renameTodo(id: number, title: string) {
    const todo = todos.find((candidate) => candidate.id === id);
    if (todo) todo.title = title;
  }

  function clearCompleted() {
    todos = todos.filter((todo) => !todo.completed);
  }

  return (
    <section
      class="relative w-full overflow-hidden rounded-[6px_14px_10px_5px] border border-rule-strong bg-paper shadow-ledger max-sm:min-h-screen max-sm:rounded-none max-sm:border-0"
      aria-labelledby="page-title"
    >
      <div
        class="completion-margin absolute inset-y-0 left-0 z-1 flex w-11 flex-col items-center border-r border-correction/35 pt-7 text-correction sm:w-21 sm:pt-11"
        aria-hidden="true"
      >
        <span class="hidden font-mono text-[0.625rem] tracking-[0.18em] [writing-mode:vertical-rl] sm:block">
          DONE
        </span>
        <strong class="font-serif text-2xl font-normal sm:mt-4 sm:text-3xl">{completed}</strong>
        <span class="mt-2 hidden w-6 -rotate-3 border-t-2 border-current sm:block"></span>
      </div>

      <header class="ml-11 border-b border-rule-strong px-5 pt-7 pb-6 sm:ml-21 sm:px-11 sm:pt-10">
        <p class="mb-5 font-mono text-[0.6875rem] tracking-[0.11em] text-faint">
          FRONTEND-FRAMEWORK / ROUTE 01
        </p>
        <div class="flex items-end justify-between gap-8 max-sm:block">
          <div>
            <h1
              id="page-title"
              class="font-serif text-[clamp(2.125rem,5vw,3.375rem)] leading-[0.98] font-normal tracking-[-0.035em]"
            >
              Things worth finishing
            </h1>
            <p class="mt-3.5 max-w-lg text-[0.9375rem] leading-relaxed text-pencil">
              One setup pass. Every checkmark patches only what changed.
            </p>
          </div>
          <div
            class="remaining-count grid min-w-22 justify-items-end pb-1 text-completion max-sm:mt-5 max-sm:flex max-sm:items-baseline max-sm:justify-start max-sm:gap-2"
            aria-live="polite"
          >
            <strong class="font-serif text-4xl leading-none font-normal max-sm:text-2xl">
              {remaining}
            </strong>
            <span class="mt-1 text-[0.6875rem] tracking-[0.06em] text-pencil uppercase">
              {remaining === 1 ? "task left" : "tasks left"}
            </span>
          </div>
        </div>
      </header>

      <form
        class="ml-11 border-b border-rule px-5 py-6 sm:ml-21 sm:px-11"
        onSubmit={addTodo}
        aria-label="Add a task"
      >
        <label
          class="mb-2 block text-xs font-semibold tracking-[0.05em] text-pencil uppercase"
          htmlFor="new-task"
        >
          New note
        </label>
        <div class="grid grid-cols-[1fr_auto] gap-2.5 max-sm:grid-cols-1">
          <input
            class="min-w-0 rounded border border-rule-strong bg-control px-4 py-3 text-graphite placeholder:text-faint focus-visible:outline-3 focus-visible:outline-focus/50"
            id="new-task"
            name="task"
            type="text"
            $bind={draft}
            placeholder="What should happen next?"
            autocomplete="off"
          />
          <button
            class="rounded border border-graphite bg-graphite px-5 font-semibold text-paper hover:bg-ink disabled:cursor-not-allowed disabled:border-rule-strong disabled:bg-transparent disabled:text-faint max-sm:min-h-11"
            type="submit"
            disabled={!canAdd}
          >
            Add task
          </button>
        </div>
      </form>

      <nav
        class="ml-11 flex gap-6 border-b border-rule-strong px-5 sm:ml-21 sm:px-11"
        aria-label="Filter tasks"
      >
        {(["all", "active", "completed"] as Filter[]).map((name) => (
          <button
            key={name}
            type="button"
            classNames={[
              "relative cursor-pointer bg-transparent py-3.5 text-[0.8125rem] text-pencil hover:text-graphite",
              {
                "font-bold text-graphite after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:-rotate-1 after:bg-correction":
                  filter === name,
              },
            ]}
            aria-pressed={filter === name}
            onClick={() => (filter = name)}
          >
            {name === "all" ? "All" : name === "active" ? "Active" : "Completed"}
          </button>
        ))}
      </nav>

      <div class="task-paper ml-11 min-h-70 bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_55px,var(--color-rule)_55px,var(--color-rule)_56px)] sm:ml-21">
        {filteredTodos.length === 0 ? (
          <div class="grid min-h-70 place-content-center justify-items-center font-serif text-faint">
            <span class="text-4xl leading-none">—</span>
            <p class="mt-3.5 italic">No notes on this page.</p>
          </div>
        ) : (
          <ul class="m-0 list-none p-0">
            {filteredTodos.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                onRemove={() => removeTodo(todo.id)}
                onRename={(title) => renameTodo(todo.id, title)}
              />
            ))}
          </ul>
        )}
      </div>

      <footer class="ledger-footer ml-11 flex min-h-14 items-center justify-between gap-5 border-t border-rule-strong px-5 py-3 font-mono text-[0.6875rem] tracking-[0.04em] text-pencil uppercase max-sm:flex-col max-sm:items-start sm:ml-21 sm:px-11">
        <span>
          {todos.length} total / {completed}
          {" completed"}
        </span>
        {completed > 0 && (
          <button
            type="button"
            class="text-correction underline decoration-transparent underline-offset-3 hover:decoration-current"
            onClick={clearCompleted}
          >
            Clear completed
          </button>
        )}
      </footer>
    </section>
  );
});
