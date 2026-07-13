import { computed, signal, type Component } from "frontend-framework";

type Filter = "all" | "active" | "completed";

interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

interface TodoRowProps {
  todo: Todo;
  onRemove: () => void;
}

export const componentSetupCounts = { app: 0, row: 0 };

declare global {
  interface Window {
    __frontendFrameworkDemo?: typeof componentSetupCounts;
  }
}

window.__frontendFrameworkDemo = componentSetupCounts;

function TodoRow(props: TodoRowProps) {
  componentSetupCounts.row += 1;
  return (
    <li className={props.todo.completed ? "todo-row todo-row--completed" : "todo-row"} data-testid={`todo-${props.todo.id}`}>
      <label className="todo-check">
        <input
          type="checkbox"
          bind:checked={props.todo.completed}
          aria-label={`Mark ${props.todo.title} as ${props.todo.completed ? "active" : "completed"}`}
        />
        <span className="check-mark" aria-hidden="true">✓</span>
      </label>
      <span className="todo-title">{props.todo.title}</span>
      <button className="remove-button" type="button" onClick={props.onRemove} aria-label={`Remove ${props.todo.title}`}>
        Remove
      </button>
    </li>
  );
}

export function App() {
  componentSetupCounts.app += 1;
  const draft = signal("");
  const filter = signal<Filter>("all");
  const todos = signal<Todo[]>([
    { id: 1, title: "Trace the first compiled template", completed: true },
    { id: 2, title: "Prove nested proxy updates", completed: false },
    { id: 3, title: "Ship without a virtual DOM", completed: false },
  ]);
  let nextId = 4;

  const filteredTodos = computed(() => {
    if (filter.value === "active") return todos.value.filter((todo) => !todo.completed);
    if (filter.value === "completed") return todos.value.filter((todo) => todo.completed);
    return todos.value;
  });
  const remaining = computed(() => todos.value.filter((todo) => !todo.completed).length);
  const completed = computed(() => todos.value.length - remaining.value);
  const canAdd = computed(() => draft.value.trim().length > 0);

  function addTodo(event: SubmitEvent) {
    event.preventDefault();
    const title = draft.value.trim();
    if (!title) return;
    todos.value.push({ id: nextId++, title, completed: false });
    draft.value = "";
  }

  function removeTodo(id: number) {
    const index = todos.value.findIndex((todo) => todo.id === id);
    if (index >= 0) todos.value.splice(index, 1);
  }

  function clearCompleted() {
    todos.value = todos.value.filter((todo) => !todo.completed);
  }

  return (
    <main className="page-shell">
      <section className="ledger" aria-labelledby="page-title">
        <div className="completion-margin" aria-hidden="true">
          <span className="margin-label">DONE</span>
          <strong>{completed.value}</strong>
          <span className="margin-rule"></span>
        </div>

        <header className="ledger-header">
          <p className="eyebrow">FRONTEND-FRAMEWORK / EXAMPLE 01</p>
          <div className="title-line">
            <div>
              <h1 id="page-title">Things worth finishing</h1>
              <p>One setup pass. Every checkmark patches only what changed.</p>
            </div>
            <div className="remaining-count" aria-live="polite">
              <strong>{remaining.value}</strong>
              <span>{remaining.value === 1 ? "task left" : "tasks left"}</span>
            </div>
          </div>
        </header>

        <form className="capture-row" onSubmit={addTodo} aria-label="Add a task">
          <label htmlFor="new-task">New note</label>
          <div className="capture-control">
            <input
              id="new-task"
              name="task"
              type="text"
              bind:value={draft}
              placeholder="What should happen next?"
              autocomplete="off"
            />
            <button type="submit" disabled={!canAdd.value}>Add task</button>
          </div>
        </form>

        <nav className="filter-tabs" aria-label="Filter tasks">
          <button type="button" className={filter.value === "all" ? "filter-tab filter-tab--active" : "filter-tab"} aria-pressed={filter.value === "all"} onClick={() => filter.value = "all"}>All</button>
          <button type="button" className={filter.value === "active" ? "filter-tab filter-tab--active" : "filter-tab"} aria-pressed={filter.value === "active"} onClick={() => filter.value = "active"}>Active</button>
          <button type="button" className={filter.value === "completed" ? "filter-tab filter-tab--active" : "filter-tab"} aria-pressed={filter.value === "completed"} onClick={() => filter.value = "completed"}>Completed</button>
        </nav>

        <div className="task-paper">
          {filteredTodos.value.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">—</span>
              <p>No notes on this page.</p>
            </div>
          ) : (
            <ul className="todo-list">
              {filteredTodos.value.map((todo) => (
                <TodoRow key={todo.id} todo={todo} onRemove={() => removeTodo(todo.id)} />
              ))}
            </ul>
          )}
        </div>

        <footer className="ledger-footer">
          <span>{todos.value.length} total / {completed.value} completed</span>
          {completed.value > 0 && (
            <button type="button" className="clear-button" onClick={clearCompleted}>Clear completed</button>
          )}
        </footer>
      </section>
    </main>
  );
}

const _componentTypeCheck: Component = App;
void _componentTypeCheck;
