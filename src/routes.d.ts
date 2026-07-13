declare module "virtual:frontend-framework/routes" {
  import type { RouteDefinition } from "./runtime.ts";

  const routes: readonly RouteDefinition[];
  export default routes;
}
