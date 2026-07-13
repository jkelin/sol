import { mount } from "solix";
import { Shell } from "./Shell.tsx";
import "./styles.css";

const target = document.querySelector("#app");
if (!target) throw new Error("The #app mount target is missing");

mount(Shell, target);
