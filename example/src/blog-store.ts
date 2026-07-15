import { $signal } from "@soljs/sol";

export interface BlogEntry {
  id: number;
  name: string;
  content: string;
}

export const blogEntries = $signal<BlogEntry[]>([
  {
    id: 1,
    name: "The compiler keeps the map",
    content: "A field note on turning authored JSX into small, traceable DOM operations.",
  },
  {
    id: 2,
    name: "Signals without ceremony",
    content: "Why ordinary assignments can still describe precise reactive updates.",
  },
]);

let nextId = 3;

export function createBlogEntry(name: string, content: string): BlogEntry {
  const entry = { id: nextId++, name, content };
  blogEntries.value.push(entry);
  return entry;
}
