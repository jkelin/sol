import "@fontsource/archivo-black/400.css";
import "@fontsource/chivo-mono/400.css";
import "@fontsource/chivo-mono/500.css";
import "@fontsource/chivo-mono/700.css";
import "@fontsource/familjen-grotesk/400.css";
import "@fontsource/familjen-grotesk/500.css";
import "@fontsource/familjen-grotesk/600.css";
import "@fontsource/familjen-grotesk/700.css";
import { App } from "./App.tsx";
import "./examples/styles.css";
import "./styles.css";
import { docs } from "virtual:sol-docs";

export { App };

export const staticPaths = docs.slice(1).map((document) => `/docs/${document.slug}`);
