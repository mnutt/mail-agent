/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { Capability, PowerboxFulfillmentApi, SandstormEnv } from "sandstorm:api";
import { POWERBOX_DESCRIPTORS } from "@mail-agent/protocol";
import type {
  ConversationChunk,
  ConversationRequest,
  JsonValue,
} from "@mail-agent/protocol";

const OPENAI_TOKEN_KEY = "openai-outbound-http-token";
const OPENAI_CONFIG_KEY = "openai-config";
const LLM_CAPABILITY_ID = "conversational-llm-v1";
const LLM_CAPABILITY_TOKEN_KEY = "conversational-llm-token";
const STATS_KEY = "llm-stats";

interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}

interface LlmStats {
  requests: number;
  errors: number;
}

interface OpenAiConfig {
  apiKey?: string;
  model: string;
}

interface OpenAiChatChoice {
  message?: {
    content?: unknown;
  };
}

interface OpenAiChatResponse {
  choices?: OpenAiChatChoice[];
  error?: {
    message?: unknown;
  };
}

interface OpenAiResponseErrorDetails {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
  requestPath: string;
  responseHeaders: Record<string, string>;
}

interface OpenAiTransportErrorDetails {
  requestPath: string;
  originalName: string;
  originalMessage: string;
  originalStack?: string;
  capabilityInfo: unknown;
}

class OpenAiResponseError extends Error {
  readonly details: OpenAiResponseErrorDetails;

  constructor(details: OpenAiResponseErrorDetails, message?: string) {
    super(message || `OpenAI request failed (${details.status}): ${details.statusText || "HTTP error"}`);
    this.name = "OpenAiResponseError";
    this.details = details;
  }
}

class OpenAiTransportError extends Error {
  readonly details: OpenAiTransportErrorDetails;

  constructor(details: OpenAiTransportErrorDetails) {
    super(`OpenAI outbound HTTP transport failed: ${details.originalMessage}`);
    this.name = "OpenAiTransportError";
    this.details = details;
  }
}

function jsonError(error: unknown, status = 500): Response {
  return Response.json({
    ok: false,
    name: String((error as Error)?.name || "Error"),
    message: String((error as Error)?.message || error),
  }, { status });
}

async function readStats(request: Request, env: Env): Promise<LlmStats> {
  const stats = await sandstorm(request, env).storage().getJson<Partial<LlmStats>>(STATS_KEY);
  return {
    requests: Math.max(0, Number(stats?.requests || 0)),
    errors: Math.max(0, Number(stats?.errors || 0)),
  };
}

async function incrementStats(
  request: Request,
  env: Env,
  increment: Partial<Record<keyof LlmStats, number>>,
): Promise<void> {
  const stats = await readStats(request, env);
  await sandstorm(request, env).storage().putJson(STATS_KEY, {
    requests: stats.requests + (increment.requests || 0),
    errors: stats.errors + (increment.errors || 0),
  });
}

async function readOpenAiConfig(request: Request, env: Env): Promise<OpenAiConfig> {
  const config = await sandstorm(request, env).storage().getJson<Partial<OpenAiConfig>>(OPENAI_CONFIG_KEY);
  return {
    apiKey: typeof config?.apiKey === "string" ? config.apiKey : undefined,
    model: typeof config?.model === "string" && config.model ? config.model : "gpt-4.1-mini",
  };
}

async function saveOpenAiConfig(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const current = await readOpenAiConfig(request, env);
  const apiKey = body.apiKey
    ? validate.string(body.apiKey, "apiKey", { maxLength: 4096 })
    : current.apiKey;
  const model = body.model
    ? validate.string(body.model, "model", { maxLength: 80 })
    : current.model;
  const next = { apiKey, model };
  await sandstorm(request, env).storage().putJson(OPENAI_CONFIG_KEY, JSON.parse(JSON.stringify(next)));
  return Response.json({
    ok: true,
    openAi: {
      hasApiKey: Boolean(next.apiKey),
      model: next.model,
    },
  });
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

function ensureJsonInstruction(request: ConversationRequest): ConversationRequest {
  if (request.responseFormat !== "json") return request;
  if (request.messages.some((message) => /\bjson\b/i.test(message.content))) return request;
  return {
    ...request,
    messages: [
      {
        role: "system",
        content: "Return only valid JSON.",
      },
      ...request.messages,
    ],
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

function parseOpenAiJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || Array.isArray(value)) {
    return value as JsonValue;
  }
  if (typeof value === "object") return value as JsonValue;
  if (typeof value !== "string") {
    throw new Error("OpenAI response did not include message content");
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return { text: value };
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function openAiErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const error = body.error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

async function completeWithOpenAi(
  capability: Capability,
  apiKey: string,
  request: ConversationRequest,
  model: string,
): Promise<JsonValue> {
  const requestPath = "/v1/chat/completions";
  const capabilityInfo = await capability.info({ refresh: true }).catch((error) => ({
    ok: false,
    error: String((error as Error)?.message || error),
  }));
  let response: Response;
  try {
    response = await capability.fetch(requestPath, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        temperature: request.temperature,
        response_format: request.responseFormat === "text" ? undefined : { type: "json_object" },
      }),
    });
  } catch (error) {
    throw new OpenAiTransportError({
      requestPath,
      originalName: String((error as Error)?.name || "Error"),
      originalMessage: String((error as Error)?.message || error),
      originalStack: (error as Error)?.stack,
      capabilityInfo,
    });
  }
  const responseText = await response.text();
  const body = parseJsonObject(responseText) as OpenAiChatResponse;

  if (!response.ok) {
    const detail = openAiErrorMessage(body as Record<string, unknown>, response.statusText || responseText.slice(0, 160));
    throw new OpenAiResponseError({
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") || "",
      body: responseText.slice(0, 4000),
      requestPath,
      responseHeaders: Object.fromEntries(response.headers),
    }, `OpenAI request failed (${response.status}): ${detail}`);
  }

  return parseOpenAiJson(body.choices?.[0]?.message?.content);
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
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {
    super();
  }

  private context(): { request: Request; env: Env } {
    return { request: this.request, env: this.env };
  }

  async completeJson(input: ConversationRequest): Promise<JsonValue> {
    const context = this.context();
    await incrementStats(context.request, context.env, { requests: 1 });
  try {
      const request = ensureJsonInstruction(normalizeConversation(input));
      const store = sandstorm(context.request, context.env).storage();
      const token = await store.get(OPENAI_TOKEN_KEY);
      const config = await readOpenAiConfig(context.request, context.env);
      if (!token || !config.apiKey) return fallbackDecision(request);

      return await sandstorm(context.request, context.env).use(token, (capability) =>
        completeWithOpenAi(capability, config.apiKey as string, request, request.model || config.model));
    } catch (error) {
      await incrementStats(context.request, context.env, { errors: 1 });
      throw error;
    }
  }

  async streamConversation(input: ConversationRequest): Promise<ConversationStreamTarget> {
    const value = await this.completeJson(input);
    return new ConversationStreamTarget({
      text: JSON.stringify(value),
      done: true,
    });
  }
}

async function ensureLlmCapability(request: Request, env: Env): Promise<Capability> {
  const result = await sandstorm(request, env, durableCapabilities).exportDurable(LLM_CAPABILITY_ID, {
    storageKey: LLM_CAPABILITY_TOKEN_KEY,
    label: "Mail agent conversational LLM",
  });
  return result.capability;
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  const store = sandstorm(request, env).storage();
  const openAiConfig = await readOpenAiConfig(request, env);
  return {
    hasOpenAiOutboundHttp: Boolean(await store.get(OPENAI_TOKEN_KEY)),
    hasLlmCapabilityToken: Boolean(await store.get(LLM_CAPABILITY_TOKEN_KEY)),
    openAi: {
      hasApiKey: Boolean(openAiConfig.apiKey),
      model: openAiConfig.model,
    },
    capabilityId: LLM_CAPABILITY_ID,
    stats: await readStats(request, env),
  };
}

async function fulfillmentPage(
  fulfillment: PowerboxFulfillmentApi,
  request: Request,
): Promise<Response> {
  const route = await fulfillment.serve(
    new Request(new URL("/__sandstorm/powerbox-fulfillment", request.url)),
  );
  if (!route) throw new Error("Powerbox fulfillment page is not available");
  return route;
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mail Agent LLM</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 2rem; }
      .header { align-items: start; display: flex; justify-content: space-between; gap: 1rem; }
      h1 { margin-bottom: 0; margin-top: 0; }
      h2 { font-size: 1rem; margin: 1.35rem 0 0.65rem; }
      .stats { display: flex; gap: 1rem; text-align: right; }
      .stat-label { color: #526173; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
      .stat-value { font-size: 1.25rem; font-weight: 650; line-height: 1.1; }
      button { border: 1px solid #205493; border-radius: 4px; background: #205493; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      button.secondary { background: white; color: #205493; }
      .controls { align-items: center; display: flex; gap: 0.4rem; margin: 0 0 0.75rem; }
      .grants { display: grid; gap: 0.75rem; margin: 0 0 1rem; }
      .grant-row { border-bottom: 1px solid #d8dee6; padding: 0 0 0.75rem; }
      .grant-title { color: #526173; font-size: 0.82rem; font-weight: 600; margin: 0 0 0.35rem; text-transform: uppercase; }
      .grant-body { align-items: center; display: flex; justify-content: space-between; gap: 1rem; }
      .grant-status { color: #172033; }
      .grant-row button { font-size: 0.86rem; margin: 0; padding: 0.28rem 0.55rem; }
      .settings-row { align-items: flex-end; display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 0.75rem; }
      .settings-row label { color: #526173; display: grid; font-size: 0.78rem; font-weight: 600; gap: 0.2rem; text-transform: uppercase; }
      input { border: 1px solid #a8b3c1; border-radius: 4px; font: inherit; padding: 0.4rem; }
      .settings-row button { margin-bottom: 0; }
      .connection-status { color: #526173; margin: 0 0 0.75rem; }
      .result { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; margin: 0 0 0.75rem; min-height: 1.4rem; overflow: auto; padding: 0.75rem; white-space: pre-wrap; }
      .result.error { border-color: #b42318; color: #8a1f11; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <div class="header">
        <h1>Mail Agent LLM</h1>
        <div class="stats">
          <div>
            <div class="stat-label">Requests</div>
            <div class="stat-value" id="request-count">0</div>
          </div>
          <div>
            <div class="stat-label">Errors</div>
            <div class="stat-value" id="error-count">0</div>
          </div>
        </div>
      </div>
      <h2>Capabilities</h2>
      <section class="grants" id="grants"></section>
      <h2>OpenAI Settings</h2>
      <div class="connection-status" id="openai-status">API key: not configured</div>
      <form class="settings-row" id="openai-config">
        <label>
          API key
          <input name="apiKey" type="password" autocomplete="off" placeholder="leave blank to keep existing key">
        </label>
        <label>
          Model
          <input name="model" id="openai-model" value="gpt-4.1-mini">
        </label>
        <button type="submit">Save Settings</button>
      </form>
      <div class="controls">
        <button id="test" type="button">Test Decision</button>
        <button id="config-toggle" class="secondary" type="button">Show config</button>
      </div>
      <div class="result" id="result">Ready.</div>
      <pre id="output" hidden></pre>
    </main>
    <script type="module">
      import { grantStatus, requestGrant, revokeGrant } from "/__sandstorm/powerbox-grants/client.js";
      import { newSandstormRpcSession } from "./rpc-client.js";
      const output = document.querySelector("#output");
      const result = document.querySelector("#result");
      const grants = document.querySelector("#grants");
      const requestCount = document.querySelector("#request-count");
      const errorCount = document.querySelector("#error-count");
      const configToggle = document.querySelector("#config-toggle");
      const openAiStatus = document.querySelector("#openai-status");
      const openAiModel = document.querySelector("#openai-model");
      let currentState = null;
      const grantDefinitions = [
        { id: "openai", title: "OpenAI API Access" },
      ];
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      function showResult(value, isError = false) {
        result.classList.toggle("error", isError);
        result.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }
      function renderState(state) {
        currentState = state;
        requestCount.textContent = String(state.stats?.requests || 0);
        errorCount.textContent = String(state.stats?.errors || 0);
        openAiStatus.textContent = "API key: " + (state.openAi?.hasApiKey ? "configured" : "not configured");
        if (state.openAi?.model) openAiModel.value = state.openAi.model;
        show(state);
      }
      async function refreshState() {
        renderState(await (await fetch("/api/state")).json());
      }
      async function refreshGrantRows() {
        const statuses = await Promise.all(grantDefinitions.map(async (grant) => ({
          ...grant,
          status: (await grantStatus(grant.id)).status,
        })));
        grants.replaceChildren(...statuses.map(renderGrantRow));
      }
      function renderGrantRow(grant) {
        const row = document.createElement("section");
        row.className = "grant-row";
        const title = document.createElement("h2");
        title.className = "grant-title";
        title.textContent = grant.title;
        const body = document.createElement("div");
        body.className = "grant-body";
        const status = document.createElement("div");
        status.className = "grant-status";
        status.textContent = "Status: " + (grant.status.connected ? "connected" : "not connected");
        const action = document.createElement("button");
        action.type = "button";
        action.textContent = grant.status.connected ? "Disconnect" : "Connect";
        if (grant.status.connected) action.className = "secondary";
        action.addEventListener("click", async () => {
          action.disabled = true;
          try {
            show(grant.status.connected ? await revokeGrant(grant.id) : await requestGrant(grant.id));
            await refreshGrantRows();
            await refreshState();
          } catch (error) {
            show({ ok: false, error: error.message || String(error) });
            action.disabled = false;
          }
        });
        body.append(status, action);
        row.append(title, body);
        return row;
      }
      async function run(callback) {
        try {
          const value = await callback();
          showResult(value);
          return value;
        } catch (error) {
          const value = {
            ok: false,
            error: error.message || String(error),
            name: error.name,
            details: error.details,
          };
          showResult(value, true);
          return value;
        }
      }
      async function post(path, body) {
        const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error(result.error || result.message || "Request failed");
        return result;
      }
      document.querySelector("#openai-config").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await run(() => post("/api/openai-config", Object.fromEntries(form.entries())));
        event.currentTarget.elements.apiKey.value = "";
        await refreshState();
      });
      document.querySelector("#test").addEventListener("click", async () => {
        await run(async () => {
          using rpc = newSandstormRpcSession();
          return await rpc.completeJson({
            messages: [
              { role: "system", content: "Classify the message. Return only valid JSON with important, confidence, summary, reason, and labels." },
              { role: "user", content: "Urgent invoice deadline tomorrow" }
            ],
            responseFormat: "json"
          });
        });
        await refreshState();
      });
      configToggle.addEventListener("click", () => {
        output.hidden = !output.hidden;
        configToggle.textContent = output.hidden ? "Show config" : "Hide config";
        if (!output.hidden && currentState) show(currentState);
      });
      await refreshGrantRows();
      await refreshState();
    </script>
  </body>
</html>`;
}

const durableCapabilities = {
  capabilities: {
    [LLM_CAPABILITY_ID]: (request: Request, env: SandstormEnv) =>
      new ConversationalLlmTarget(request, env as Env),
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = sandstorm(request, env, durableCapabilities);
    const grants = api.powerboxGrants({
      grants: {
        openai: {
          title: "OpenAI API Access",
          description: "Used by the sample classifier when outbound HTTP is connected.",
          storageKey: OPENAI_TOKEN_KEY,
          outboundHttp: {
            baseUrl: "https://api.openai.com/",
            methods: ["GET", "POST"],
          },
          saveLabel: { defaultText: "OpenAI outbound HTTP" },
          save: { label: "OpenAI outbound HTTP" },
        },
      },
    });
    const fulfillment = api.powerboxFulfillment({
      title: "Mail Agent LLM",
      description: "Provides the Mail Agent conversational LLM protocol.",
      buttonLabel: "Use This LLM",
      capability: () => ensureLlmCapability(request, env),
      fulfill: {
        title: "Mail Agent LLM",
        verbPhrase: "can classify messages",
        description: "Provides the Mail Agent conversational LLM protocol.",
        requiredPermissions: ["view"],
        descriptor: POWERBOX_DESCRIPTORS.conversationalLlm,
      },
    });
    const session = api.session();
    const url = new URL(request.url);

    try {
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const grantRoute = await grants.serve(request);
      if (grantRoute) return grantRoute;

      const fulfillmentRoute = await fulfillment.serve(request);
      if (fulfillmentRoute) return fulfillmentRoute;

      const rpcRoute = await api.serveRpc(() => new ConversationalLlmTarget(request, env));
      if (rpcRoute) return rpcRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/openai-config") {
        return saveOpenAiConfig(request, env);
      }

      if (session.sessionType === "request") return fulfillmentPage(fulfillment, request);

      return new Response(html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
