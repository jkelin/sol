import { renderToStringAsync } from "solix";
import type { RequestHandler, RenderContext, SolkitRoot } from "./types.ts";

const HEAD_OUTLET = "<!--solkit-head-->";
const BODY_OUTLET = "<!--solkit-body-->";

function validateTemplate(template: unknown): asserts template is string {
  if (typeof template !== "string") throw new TypeError("Solkit template must be a string");
  for (const outlet of [HEAD_OUTLET, BODY_OUTLET]) {
    const occurrences = template.split(outlet).length - 1;
    if (occurrences !== 1) {
      throw new TypeError(`Solkit template must contain ${outlet} exactly once`);
    }
  }
}

function validateRequest(request: unknown): asserts request is Request {
  if (!(request instanceof Request)) throw new TypeError("Solkit handler expects a Request");
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("Solkit document handler accepts only GET and HEAD requests");
  }
}

export function createRequestHandler(root: SolkitRoot): RequestHandler {
  if (typeof root !== "function") throw new TypeError("Solkit root must be a compiled component");
  return async (request: Request, context: RenderContext): Promise<Response> => {
    validateRequest(request);
    if (!context || typeof context !== "object") {
      throw new TypeError("Solkit render context must be an object");
    }
    validateTemplate(context.template);
    let head = "";
    const body = await renderToStringAsync(root, undefined, {
      url: request.url,
      onHead(value) {
        head = value;
      },
    });
    const document = context.template.replace(HEAD_OUTLET, head).replace(BODY_OUTLET, body);
    return new Response(request.method === "HEAD" ? null : document, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}

export type {
  RequestHandler,
  RenderContext,
  SolkitAdapter,
  SolkitAdapterContext,
  SolkitOptions,
  SolkitRoot,
} from "./types.ts";
