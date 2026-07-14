declare module "virtual:solix/routes" {
  const routes: readonly import("./routes.ts").RouteDefinition[];
  export default routes;
}

declare module "virtual:solix/server-endpoints" {
  const endpoints: readonly import("./server-functions.ts").ServerEndpoint[];
  export default endpoints;
}
