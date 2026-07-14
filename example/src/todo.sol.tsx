import { $route } from "sol";
import { App } from "./App.tsx";

export const todoRoute = $route({ path: "/" }, App);
