/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { ClaimedCapability, SandstormEnv } from "sandstorm:api";
import { POWERBOX_DESCRIPTORS } from "@mail-agent/protocol";
import type {
  AddMessageResult,
  Message,
  MessageQuery,
} from "@mail-agent/protocol";

const MESSAGES_KEY = "messages";
const MESSAGE_SINK_ID = "message-sink-v1";
const MESSAGE_INBOX_ID = "message-inbox-v1";
const MESSAGE_SINK_TOKEN_KEY = "message-sink-token";
const MESSAGE_INBOX_TOKEN_KEY = "message-inbox-token";

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

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeMessage(input: Message): Message {
  return {
    id: input.id ? validate.string(input.id, "id", { maxLength: 160 }) : crypto.randomUUID(),
    source: "mail",
    title: validate.string(input.title || "Message", "title", { maxLength: 300 }),
    body: validate.string(input.body || "", "body", { maxLength: 4000 }),
    priority: input.priority === "high" ? "high" : "normal",
    createdAt: input.createdAt || nowIso(),
    dedupeKey: validate.string(input.dedupeKey || input.id || crypto.randomUUID(), "dedupeKey", {
      maxLength: 300,
    }),
    actionUrl: input.actionUrl ? validate.string(input.actionUrl, "actionUrl", { maxLength: 2048 }) : undefined,
    sourceRef: {
      messageKey: input.sourceRef?.messageKey,
      messageId: input.sourceRef?.messageId,
      from: Array.isArray(input.sourceRef?.from) ? input.sourceRef.from : [],
      receivedAt: input.sourceRef?.receivedAt,
    },
    labels: Array.isArray(input.labels) ? input.labels.map((label) => String(label)).slice(0, 20) : [],
    read: Boolean(input.read),
    archived: Boolean(input.archived),
  };
}

async function readMessages(env: Env, request: Request): Promise<Message[]> {
  return (await sandstorm(request, env).storage().getJson<Message[]>(MESSAGES_KEY)) || [];
}

async function writeMessages(env: Env, request: Request, messages: Message[]): Promise<void> {
  await sandstorm(request, env).storage().putJson(MESSAGES_KEY, JSON.parse(JSON.stringify(messages)));
}

class MessageStore {
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {}

  async list(query: MessageQuery = {}): Promise<Message[]> {
    const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
    return (await readMessages(this.env, this.request))
      .filter((message) => query.includeArchived || !message.archived)
      .filter((message) => !query.unreadOnly || !message.read)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async add(input: Message): Promise<AddMessageResult> {
    const next = normalizeMessage(input);
    const messages = await readMessages(this.env, this.request);
    const existing = messages.find((message) =>
      message.source === next.source && message.dedupeKey === next.dedupeKey);
    if (existing) return { ok: true, id: existing.id, deduped: true };

    messages.push(next);
    await writeMessages(this.env, this.request, messages);
    return { ok: true, id: next.id, deduped: false };
  }

  async markRead(id: string): Promise<void> {
    await this.update(id, (message) => ({ ...message, read: true }));
  }

  async archive(id: string): Promise<void> {
    await this.update(id, (message) => ({ ...message, archived: true, read: true }));
  }

  private async update(id: string, mapper: (message: Message) => Message): Promise<void> {
    const messages = await readMessages(this.env, this.request);
    await writeMessages(this.env, this.request, messages.map((message) =>
      message.id === id ? mapper(message) : message));
  }
}

class MessageSinkTarget extends RpcTarget {
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

  private store(): MessageStore {
    if (!this.request || !this.env) {
      throw new Error("Message sink is not bound to a request");
    }
    return new MessageStore(this.request, this.env);
  }

  addMessage(message: Message): Promise<AddMessageResult> {
    return this.store().add(message);
  }
}

class MessageInboxTarget extends RpcTarget {
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

  private store(): MessageStore {
    if (!this.request || !this.env) {
      throw new Error("Message inbox is not bound to a request");
    }
    return new MessageStore(this.request, this.env);
  }

  listMessages(query: MessageQuery = {}): Promise<Message[]> {
    return this.store().list(query);
  }

  markRead(id: string): Promise<void> {
    return this.store().markRead(validate.string(id, "id", { maxLength: 160 }));
  }

  archive(id: string): Promise<void> {
    return this.store().archive(validate.string(id, "id", { maxLength: 160 }));
  }
}

const messageSinkTarget = new MessageSinkTarget();
const messageInboxTarget = new MessageInboxTarget();

async function ensureCapabilities(request: Request, env: Env): Promise<{
  sink: ClaimedCapability;
  inbox: ClaimedCapability;
}> {
  const api = sandstorm(request, env);
  const sink = await api.persistentCapability(messageSinkTarget.bind(request, env), {
    id: MESSAGE_SINK_ID,
    storageKey: MESSAGE_SINK_TOKEN_KEY,
    label: "Mail agent message sink",
  });
  const inbox = await api.persistentCapability(messageInboxTarget.bind(request, env), {
    id: MESSAGE_INBOX_ID,
    storageKey: MESSAGE_INBOX_TOKEN_KEY,
    label: "Mail agent message inbox",
  });
  return { sink: sink.capability, inbox: inbox.capability };
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  const messages = await readMessages(env, request);
  return {
    count: messages.length,
    unread: messages.filter((message) => !message.read && !message.archived).length,
    sinkCapabilityId: MESSAGE_SINK_ID,
    inboxCapabilityId: MESSAGE_INBOX_ID,
  };
}

async function fulfillMessageSinkRequest(request: Request, env: Env): Promise<Response> {
  const capabilities = await ensureCapabilities(request, env);
  const fulfill = await capabilities.sink.fulfillRequest(request, {
    title: "Mail Agent Message Sink",
    verbPhrase: "can receive important messages",
    description: "Stores classified mail messages from Mail Agent.",
    requiredPermissions: ["view"],
    descriptor: POWERBOX_DESCRIPTORS.messageSink,
  });
  return Response.json({
    ok: true,
    fulfill,
    sink: JSON.parse(JSON.stringify(capabilities.sink)),
  });
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mail Agent Messages</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 2rem; }
      main { max-width: 58rem; }
      button { border: 1px solid #1b6a52; border-radius: 4px; background: #1b6a52; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      li { border-bottom: 1px solid #d8dee6; padding: 0.75rem 0; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Messages</h1>
      <button id="sample" type="button">Add Sample</button>
      <ul id="messages"></ul>
      <pre id="output">Ready.</pre>
    </main>
    <script type="module">
      import { newSandstormRpcSession } from "./rpc-client.js";
      const output = document.querySelector("#output");
      const list = document.querySelector("#messages");
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      async function refresh() {
        using rpc = newSandstormRpcSession();
        const messages = await rpc.listMessages({ includeArchived: false, limit: 50 });
        list.replaceChildren(...messages.map((message) => {
          const item = document.createElement("li");
          item.textContent = message.title + " - " + message.body;
          return item;
        }));
        show(await (await fetch("/api/state")).json());
      }
      document.querySelector("#sample").addEventListener("click", async () => {
        using rpc = newSandstormRpcSession();
        show(await rpc.addMessage({
          id: crypto.randomUUID(),
          source: "mail",
          title: "Sample important email",
          body: "A generated inbox item.",
          priority: "normal",
          createdAt: new Date().toISOString(),
          dedupeKey: crypto.randomUUID(),
          sourceRef: { from: [] },
          labels: ["sample"]
        }));
        await refresh();
      });
      await refresh();
    </script>
  </body>
</html>`;
}

function powerboxRequestHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mail Agent Message Sink</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 1.25rem; }
      main { max-width: 34rem; }
      button { border: 1px solid #1b6a52; border-radius: 4px; background: #1b6a52; color: white; cursor: pointer; font: inherit; padding: 0.45rem 0.7rem; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 0.75rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Mail Agent Message Sink</h1>
      <button id="provide" type="button">Use This Message Sink</button>
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
      messageSinkTarget.bind(request, env);
      messageInboxTarget.bind(request, env);
      api.registerCapability(messageSinkTarget, { id: MESSAGE_SINK_ID });
      api.registerCapability(messageInboxTarget, { id: MESSAGE_INBOX_ID });

      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const rpcRoute = await api.serveRpc(() => {
        const store = new MessageStore(request, env);
        return new class MessagesApi extends RpcTarget {
          addMessage(message: Message): Promise<AddMessageResult> {
            return store.add(message);
          }

          listMessages(query: MessageQuery = {}): Promise<Message[]> {
            return store.list(query);
          }

          markRead(id: string): Promise<void> {
            return store.markRead(validate.string(id, "id", { maxLength: 160 }));
          }

          archive(id: string): Promise<void> {
            return store.archive(validate.string(id, "id", { maxLength: 160 }));
          }
        }();
      });
      if (rpcRoute) return rpcRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/powerbox/fulfill") {
        return fulfillMessageSinkRequest(request, env);
      }

      return new Response(session.sessionType === "request" ? powerboxRequestHtml() : html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
