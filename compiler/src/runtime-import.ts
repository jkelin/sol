import { parse } from "@babel/parser";
import * as t from "@babel/types";

const RUNTIME_HELPERS = [
  ["asyncCaptureActive", "__sol_async_capture_active"],
  ["asyncCaptureCall", "__sol_async_capture_call"],
  ["asyncValue", "__sol_async_value"],
  ["computedInFrame", "__sol_computed"],
  ["$signal", "__sol_signal"],
  ["attribute", "__sol_attribute"],
  ["awaitBlock", "__sol_await"],
  ["bindValue", "__sol_bind"],
  ["block", "__sol_block"],
  ["blockLifecycle", "__sol_block_lifecycle"],
  ["child", "__sol_child"],
  ["component", "__sol_component"],
  ["runCleanups", "__sol_cleanup"],
  ["rethrowWithCleanups", "__sol_rethrow"],
  ["contextProvider", "__sol_context_provider"],
  ["contextMethod", "__sol_context_method"],
  ["contextUse", "__sol_context_use"],
  ["emptyBlock", "__sol_empty_block"],
  ["errorBoundary", "__sol_error_boundary"],
  ["event", "__sol_event"],
  ["formInFrame", "__sol_form"],
  ["globalPortal", "__sol_global_portal"],
  ["head", "__sol_head"],
  ["instantiate", "__sol_instantiate"],
  ["link", "__sol_link"],
  ["list", "__sol_list"],
  ["portal", "__sol_portal"],
  ["rawText", "__sol_raw_text"],
  ["ref", "__sol_ref"],
  ["requestSource", "__sol_request_source"],
  ["queryInFrame", "__sol_query"],
  ["mutationInFrame", "__sol_mutation"],
  ["route", "__sol_route"],
  ["routeObject", "__sol_route_object"],
  ["routeRead", "__sol_route_read"],
  ["routeHandle", "__sol_route_handle"],
  ["suspense", "__sol_suspense"],
  ["template", "__sol_template"],
  ["staticText", "__sol_static_text"],
  ["text", "__sol_text"],
  ["transition", "__sol_transition"],
  ["valueBlock", "__sol_value_block"],
  ["when", "__sol_when"],
] as const;

export function runtimeImport(generatedCode: string): string {
  const referenced = new Set<string>();
  const ast = parse(generatedCode, { sourceType: "module", plugins: ["typescript"] });
  const visit = (node: t.Node, parent?: t.Node, grandparent?: t.Node): void => {
    if (parent && t.isIdentifier(node) && t.isReferenced(node, parent, grandparent)) {
      referenced.add(node.name);
    }
    const fields = node as unknown as Readonly<Record<string, unknown>>;
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const value = fields[key];
      if (Array.isArray(value)) {
        for (const child of value) if (t.isNode(child)) visit(child, node, parent);
      } else if (t.isNode(value)) visit(value, node, parent);
    }
  };
  visit(ast);
  const used = RUNTIME_HELPERS.filter(([, local]) => referenced.has(local));
  if (used.length === 0) return "";
  const specifiers = used.map(([exported, local]) => `  ${exported} as ${local}`).join(",\n");
  return `import {\n${specifiers}\n} from "sol/compiler-runtime";`;
}
