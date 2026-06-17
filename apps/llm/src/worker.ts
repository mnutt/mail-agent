/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { ClaimedCapability, SandstormEnv } from "sandstorm:api";
import { POWERBOX_DESCRIPTORS } from "@mail-agent/protocol";
import type {
  ConversationChunk,
  ConversationRequest,
  JsonValue,
} from "@mail-agent/protocol";

const OPENAI_TOKEN_KEY = "openai-outbound-http-token";
const LLM_CAPABILITY_ID = "conversational-llm-v1";
const LLM_CAPABILITY_TOKEN_KEY = "conversational-llm-token";

interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}

function jsonError(error: unknown, status = 500): Response {
  return Response.json({
    ok: false,
    name: String((error as Error)?.name || "Error"),
    message: String((error as Error)?.message || error),
  }, { status });
}

function normalizeConversation(request: ConversationRequest): ConversationRequest {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  return {
    messages: messages.map((message) => ({
      role: message.role === "assistant" || message.role === "system" ? message.role : "user",
      content: validate.string(message.content, "message.content", { maxLength: 20000 }),
    })),
    responseFormat: request.responseFormat === "text" ? "text" : "json",
    model: request.model ? validate.string(request.model, "model", { maxLength: 80 }) : undefined,
    temperature: typeof request.temperature === "number" ? request.temperature : undefined,
  };
}

function fallbackDecision(request: ConversationRequest): JsonValue {
  const text = request.messages.map((message) => message.content).join("\n").toLowerCase();
  const urgent =
    /\b(deadline|urgent|asap|action required|invoice|flight|security|password|overdue)\b/.test(text);
  return {
    important: urgent,
    confidence: urgent ? 0.72 : 0.42,
    summary: urgent ? "Message appears to require timely attention." : "Message does not look urgent.",
    reason: urgent ? "Matched action-oriented terms." : "No high-priority signal matched.",
    labels: urgent ? ["needs-review"] : [],
  };
}

class ConversationStreamTarget extends RpcTarget {
  #sent = false;

  constructor(private readonly chunk: ConversationChunk) {
    super();
  }

  next(): ConversationChunk | null {
    if (this.#sent) return null;
    this.#sent = true;
    return this.chunk;
  }

  cancel(): void {
    this.#sent = true;
  }
}

class ConversationalLlmTarget extends RpcTarget {
  private request?: Request;
  private env?: Env;

  constructor() {
    super();
  }

  bind(request: Request, env: Env): this {
    this.request = request;
    this.env = env;
    return this;
  }

  private context(): { request: Request; env: Env } {
    if (!this.request || !this.env) {
      throw new Error("Conversational LLM is not bound to a request");
    }
    return { request: this.request, env: this.env };
  }

  async completeJson(input: ConversationRequest): Promise<JsonValue> {
    const request = normalizeConversation(input);
    const context = this.context();
    const store = sandstorm(context.request, context.env).storage();
    const token = await store.get(OPENAI_TOKEN_KEY);
    if (!token) return fallbackDecision(request);

    const decision = fallbackDecision(request) as Record<string, JsonValue>;
    return {
      ...decision,
      provider: "local-fallback",
      outboundHttpConfigured: true,
      note: "OpenAI OutboundHttpSession is saved, but the isolate helper surface does not yet expose a usable OutboundHttpSession.request() adapter.",
    };
  }

  async streamConversation(input: ConversationRequest): Promise<ConversationStreamTarget> {
    const value = await this.completeJson(input);
    return new ConversationStreamTarget({
      text: JSON.stringify(value),
      done: true,
    });
  }
}

const conversationalLlmTarget = new ConversationalLlmTarget();

async function ensureLlmCapability(request: Request, env: Env): Promise<ClaimedCapability> {
  const result = await sandstorm(request, env).persistentCapability(conversationalLlmTarget.bind(request, env), {
    id: LLM_CAPABILITY_ID,
    storageKey: LLM_CAPABILITY_TOKEN_KEY,
    label: "Mail agent conversational LLM",
  });
  return result.capability;
}

async function claimOutboundHttp(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const claimed = await sandstorm(request, env).powerbox().claimAndStoreRequest(body, {
    storageKey: OPENAI_TOKEN_KEY,
    label: "OpenAI outbound HTTP",
  });
  await claimed.capability.drop();
  return Response.json({
    ok: true,
    storageKey: OPENAI_TOKEN_KEY,
    saved: JSON.parse(JSON.stringify(claimed.saved)),
  });
}

async function fulfillLlmRequest(request: Request, env: Env): Promise<Response> {
  const capability = await ensureLlmCapability(request, env);
  const fulfill = await capability.fulfillRequest(request, {
    title: "Mail Agent LLM",
    verbPhrase: "can classify messages",
    description: "Provides the Mail Agent conversational LLM protocol.",
    requiredPermissions: ["view"],
    descriptor: POWERBOX_DESCRIPTORS.conversationalLlm,
  });
  return Response.json({
    ok: true,
    fulfill,
    capability: JSON.parse(JSON.stringify(capability)),
  });
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  const store = sandstorm(request, env).storage();
  return {
    hasOpenAiOutboundHttp: Boolean(await store.get(OPENAI_TOKEN_KEY)),
    hasLlmCapabilityToken: Boolean(await store.get(LLM_CAPABILITY_TOKEN_KEY)),
    capabilityId: LLM_CAPABILITY_ID,
  };
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mail Agent LLM</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 2rem; }
      main { max-width: 52rem; }
      button { border: 1px solid #205493; border-radius: 4px; background: #205493; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Mail Agent LLM</h1>
      <button id="connect" type="button">Connect OpenAI</button>
      <button id="test" type="button">Test Decision</button>
      <pre id="output">Ready.</pre>
    </main>
    <script type="module">
      import { requestOutboundHttpPowerbox, newSandstormRpcSession } from "./rpc-client.js";
      const output = document.querySelector("#output");
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      async function post(path, body) {
        const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error(result.error || result.message || "Request failed");
        return result;
      }
      async function run(callback) {
        try {
          show(await callback());
        } catch (error) {
          show({ ok: false, error: error.message || String(error) });
        }
      }
      document.querySelector("#connect").addEventListener("click", async () => {
        show("Opening Powerbox...");
        await run(async () => {
          const requested = await requestOutboundHttpPowerbox({
            baseUrl: "https://api.openai.com/",
            methods: ["GET", "POST"],
            saveLabel: { defaultText: "OpenAI outbound HTTP" },
          });
          return await post("/api/openai/claim", requested);
        });
      });
      document.querySelector("#test").addEventListener("click", async () => {
        await run(async () => {
          using rpc = newSandstormRpcSession();
          return await rpc.completeJson({ messages: [{ role: "user", content: "Urgent invoice deadline tomorrow" }], responseFormat: "json" });
        });
      });
      show(await (await fetch("/api/state")).json());
    </script>
  </body>
</html>`;
}

function powerboxRequestHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mail Agent LLM</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 1.25rem; }
      main { max-width: 32rem; }
      button { border: 1px solid #205493; border-radius: 4px; background: #205493; color: white; cursor: pointer; font: inherit; padding: 0.45rem 0.7rem; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 0.75rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Mail Agent LLM</h1>
      <button id="provide" type="button">Use This LLM</button>
      <pre id="output">Ready.</pre>
    </main>
    <script type="module">
      const button = document.querySelector("#provide");
      const output = document.querySelector("#output");
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      button.addEventListener("click", async () => {
        button.disabled = true;
        show("Connecting...");
        try {
          const response = await fetch("/api/powerbox/fulfill", { method: "POST" });
          const result = await response.json();
          if (!response.ok || result.ok === false) throw new Error(result.error || result.message || "Request failed");
          show(result);
        } catch (error) {
          button.disabled = false;
          show({ ok: false, error: error.message || String(error) });
        }
      });
    </script>
  </body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = sandstorm(request, env);
    const session = api.session();
    const url = new URL(request.url);

    try {
      api.registerCapability(conversationalLlmTarget.bind(request, env), {
        id: LLM_CAPABILITY_ID,
      });

      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const rpcRoute = await api.serveRpc(() => conversationalLlmTarget.bind(request, env));
      if (rpcRoute) return rpcRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/openai/claim") {
        return claimOutboundHttp(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/powerbox/fulfill") {
        return fulfillLlmRequest(request, env);
      }

      return new Response(session.sessionType === "request" ? powerboxRequestHtml() : html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
