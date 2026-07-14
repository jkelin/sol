import { $route } from "solix";
import { App } from "./App.tsx";

export const todoRoute = $route({ path: "/" }, App);
