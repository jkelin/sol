import "@fontsource/archivo-black/400.css";
import "@fontsource/chivo-mono/400.css";
import "@fontsource/chivo-mono/500.css";
import "@fontsource/chivo-mono/700.css";
import "@fontsource/familjen-grotesk/400.css";
import "@fontsource/familjen-grotesk/500.css";
import "@fontsource/familjen-grotesk/600.css";
import "@fontsource/familjen-grotesk/700.css";
import { mount } from "solix";
import { App } from "./App.tsx";
import "./styles.css";

const target = document.querySelector("#app");
if (!target) throw new Error("The #app mount target is missing");

mount(App, target);
