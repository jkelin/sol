import { renderToStringAsync } from "solix";
import { dispatchServerEndpoint } from "solix/compiler-runtime";
import type {
  RequestHandler,
  RequestHandlerOptions,
  RenderContext,
  ServerEndpoint,
  SolkitRoot,
} from "./types.ts";

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
}

export function createRequestHandler(
  root: SolkitRoot,
  endpoints: readonly ServerEndpoint[] = [],
  options: RequestHandlerOptions = {},
): RequestHandler {
  if (typeof root !== "function") throw new TypeError("Solkit root must be a compiled component");
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Solkit request handler options must be an object");
  }
  const unexpected = Object.keys(options).find((key) => key !== "maxBodyBytes");
  if (unexpected) throw new TypeError(`Unknown Solkit request handler option ${unexpected}`);
  const maxBodyBytes = options.maxBodyBytes;
  if (maxBodyBytes !== undefined && (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0)) {
    throw new TypeError("Solkit maxBodyBytes must be a non-negative safe integer");
  }
  return async (request: Request, context: RenderContext): Promise<Response> => {
    validateRequest(request);
    if (!context || typeof context !== "object") {
      throw new TypeError("Solkit render context must be an object");
    }
    const endpoint = await dispatchServerEndpoint(endpoints, request, {
      development: context.development,
      maxBodyBytes,
    });
    if (endpoint) return endpoint;
    validateTemplate(context.template);
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined);
      return new Response("Not Found", { status: 404 });
    }
    const accept = request.headers.get("accept") ?? "";
    const pathname = new URL(request.url).pathname;
    const acceptsDocument =
      accept.includes("text/html") ||
      ((!accept || accept.includes("*/*")) && !/\/[^/]*\.[^/]+$/.test(pathname));
    if (!acceptsDocument) return new Response("Not Found", { status: 404 });
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
  RequestHandlerOptions,
  RenderContext,
  SolkitAdapter,
  SolkitAdapterContext,
  SolkitOptions,
  SolkitRoot,
} from "./types.ts";
