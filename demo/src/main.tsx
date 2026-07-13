import { mount } from "frontend-framework";
import { App } from "./App.tsx";
import "./styles.css";

const target = document.querySelector("#app");
if (!target) throw new Error("The #app mount target is missing");

mount(App, target);
