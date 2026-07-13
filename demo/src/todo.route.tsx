import { $route } from "frontend-framework";
import { App } from "./App.tsx";

export const todoRoute = $route({ path: "/" }, App);
