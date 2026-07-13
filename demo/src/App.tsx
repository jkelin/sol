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
    __frontendFrameworkDemo?: typeof componentSetupCounts;
  }
}

window.__frontendFrameworkDemo = componentSetupCounts;

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
      className={["todo-row", { "todo-row--completed": props.todo.completed, "todo-row--editing": editing }]}
      data-testid={`todo-${props.todo.id}`}
    >
      <label class="todo-check">
        <input
          type="checkbox"
          $bind={props.todo.completed}
          aria-label={`Mark ${props.todo.title} as ${props.todo.completed ? "active" : "completed"}`}
        />
        <span class="check-mark" aria-hidden="true">✓</span>
      </label>
      <input
        class="todo-editor"
        $bind={editDraft}
        aria-label={`Edit ${props.todo.title}`}
        hidden={!editing}
        onBlur={finishEditing}
        onKeyDown={handleEditKey}
      />
      <button class="todo-title" type="button" hidden={editing} onClick={beginEditing} aria-label={`Edit ${props.todo.title}`}>
        {props.todo.title}
      </button>
      <button class="remove-button" type="button" onClick={props.onRemove} aria-label={`Remove ${props.todo.title}`}>
        Remove
      </button>
    </li>
  );
});

export const App = $component(function App() {
  componentSetupCounts.app += 1;
  let draft = "";
  let filter: Filter = "all" as Filter;
  let todos: Todo[] = [
    { id: 1, title: "Trace the first compiled template", completed: true },
    { id: 2, title: "Prove nested proxy updates", completed: false },
    { id: 3, title: "Ship without a virtual DOM", completed: false },
  ];
  let nextId = 4;

  const filteredTodos = filter === "active"
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
    <main class="page-shell">
      <section className="ledger" aria-labelledby="page-title">
        <div class="completion-margin" aria-hidden="true">
          <span class="margin-label">DONE</span>
          <strong>{completed}</strong>
          <span class="margin-rule"></span>
        </div>

        <header class="ledger-header">
          <p class="eyebrow">FRONTEND-FRAMEWORK / EXAMPLE 01</p>
          <div class="title-line">
            <div>
              <h1 id="page-title">Things worth finishing</h1>
              <p>One setup pass. Every checkmark patches only what changed.</p>
            </div>
            <div class="remaining-count" aria-live="polite">
              <strong>{remaining}</strong>
              <span>{remaining === 1 ? "task left" : "tasks left"}</span>
            </div>
          </div>
        </header>

        <form class="capture-row" onSubmit={addTodo} aria-label="Add a task">
          <label htmlFor="new-task">New note</label>
          <div class="capture-control">
            <input
              id="new-task"
              name="task"
              type="text"
              $bind={draft}
              placeholder="What should happen next?"
              autocomplete="off"
            />
            <button type="submit" disabled={!canAdd}>Add task</button>
          </div>
        </form>

        <nav class="filter-tabs" aria-label="Filter tasks">
          <button type="button" classNames={{ "filter-tab": true, "filter-tab--active": filter === "all" }} aria-pressed={filter === "all"} onClick={() => filter = "all"}>All</button>
          <button type="button" classNames={{ "filter-tab": true, "filter-tab--active": filter === "active" }} aria-pressed={filter === "active"} onClick={() => filter = "active"}>Active</button>
          <button type="button" classNames={{ "filter-tab": true, "filter-tab--active": filter === "completed" }} aria-pressed={filter === "completed"} onClick={() => filter = "completed"}>Completed</button>
        </nav>

        <div class="task-paper">
          {filteredTodos.length === 0 ? (
            <div class="empty-state">
              <span aria-hidden="true">—</span>
              <p>No notes on this page.</p>
            </div>
          ) : (
            <ul class="todo-list">
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

        <footer class="ledger-footer">
          <span>{todos.length} total / {completed} completed</span>
          {completed > 0 && (
            <button type="button" class="clear-button" onClick={clearCompleted}>Clear completed</button>
          )}
        </footer>
      </section>
    </main>
  );
});
