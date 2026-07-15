import { $route } from "@soljs/sol";
import { App } from "./App.tsx";

export const todoRoute = $route({ path: "/" }, App);
