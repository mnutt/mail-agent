/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { Capability, PowerboxFulfillmentApi, SandstormEnv } from "sandstorm:api";
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
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {
    super();
  }

  private store(): MessageStore {
    return new MessageStore(this.request, this.env);
  }

  addMessage(message: Message): Promise<AddMessageResult> {
    return this.store().add(message);
  }
}

class MessageInboxTarget extends RpcTarget {
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {
    super();
  }

  private store(): MessageStore {
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

async function ensureMessageSink(request: Request, env: Env): Promise<Capability> {
  const result = await sandstorm(request, env, durableCapabilities).exportDurable(MESSAGE_SINK_ID, {
    storageKey: MESSAGE_SINK_TOKEN_KEY,
    label: "Mail agent message sink",
  });
  return result.capability;
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  const messages = await readMessages(env, request);
  return {
    count: messages.length,
    unread: messages.filter((message) => !message.read && !message.archived).length,
    archived: messages.filter((message) => message.archived).length,
    sinkCapabilityId: MESSAGE_SINK_ID,
    inboxCapabilityId: MESSAGE_INBOX_ID,
  };
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mail Agent Messages</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 2rem; }
      .header { align-items: start; display: flex; justify-content: space-between; gap: 1rem; }
      h1 { margin-bottom: 0; margin-top: 0; }
      h2 { font-size: 1rem; margin: 1.35rem 0 0.65rem; }
      .stats { display: flex; gap: 1rem; text-align: right; }
      .stat-label { color: #526173; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
      .stat-value { font-size: 1.25rem; font-weight: 650; line-height: 1.1; }
      button { border: 1px solid #1b6a52; border-radius: 4px; background: #1b6a52; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      button.secondary { background: white; color: #1b6a52; }
      .controls { align-items: center; display: flex; gap: 0.4rem; margin: 0 0 0.75rem; }
      table { border-collapse: collapse; margin: 0 0 1rem; width: 100%; }
      th, td { border-bottom: 1px solid #d8dee6; padding: 0.45rem 0.55rem; text-align: left; vertical-align: top; }
      th { color: #526173; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; }
      td.empty { color: #526173; padding: 0.75rem 0.55rem; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <div class="header">
        <h1>Messages</h1>
        <div class="stats">
          <div>
            <div class="stat-label">Total</div>
            <div class="stat-value" id="total-count">0</div>
          </div>
          <div>
            <div class="stat-label">Unread</div>
            <div class="stat-value" id="unread-count">0</div>
          </div>
        </div>
      </div>
      <div class="controls">
        <button id="sample" type="button">Add Sample</button>
        <button id="config-toggle" class="secondary" type="button">Show config</button>
      </div>
      <h2>Inbox</h2>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Priority</th>
            <th>Body</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody id="messages"></tbody>
      </table>
      <pre id="output" hidden></pre>
    </main>
    <script type="module">
      import { newSandstormRpcSession } from "./rpc-client.js";
      const output = document.querySelector("#output");
      const list = document.querySelector("#messages");
      const totalCount = document.querySelector("#total-count");
      const unreadCount = document.querySelector("#unread-count");
      const configToggle = document.querySelector("#config-toggle");
      let currentState = null;
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      function renderState(state) {
        currentState = state;
        totalCount.textContent = String(state.count || 0);
        unreadCount.textContent = String(state.unread || 0);
        show(state);
      }
      function renderMessages(messages) {
        if (!messages.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.className = "empty";
          cell.colSpan = 4;
          cell.textContent = "No messages.";
          row.append(cell);
          list.replaceChildren(row);
          return;
        }
        list.replaceChildren(...messages.map((message) => {
          const row = document.createElement("tr");
          const title = document.createElement("td");
          title.textContent = message.title || "";
          const priority = document.createElement("td");
          priority.textContent = message.priority || "";
          const body = document.createElement("td");
          body.textContent = message.body || "";
          const created = document.createElement("td");
          created.textContent = message.createdAt ? new Date(message.createdAt).toLocaleString() : "";
          row.append(title, priority, body, created);
          return row;
        }));
      }
      async function refresh() {
        using rpc = newSandstormRpcSession();
        const messages = await rpc.listMessages({ includeArchived: false, limit: 50 });
        renderMessages(messages);
        renderState(await (await fetch("/api/state")).json());
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
      configToggle.addEventListener("click", () => {
        output.hidden = !output.hidden;
        configToggle.textContent = output.hidden ? "Show config" : "Hide config";
        if (!output.hidden && currentState) show(currentState);
      });
      await refresh();
    </script>
  </body>
</html>`;
}

const durableCapabilities = {
  capabilities: {
    [MESSAGE_SINK_ID]: (request: Request, env: SandstormEnv) => new MessageSinkTarget(request, env as Env),
    [MESSAGE_INBOX_ID]: (request: Request, env: SandstormEnv) => new MessageInboxTarget(request, env as Env),
  },
};

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = sandstorm(request, env, durableCapabilities);
    const fulfillment = api.powerboxFulfillment({
      title: "Mail Agent Message Sink",
      description: "Stores classified mail messages from Mail Agent.",
      buttonLabel: "Use This Message Sink",
      capability: () => ensureMessageSink(request, env),
      fulfill: {
        title: "Mail Agent Message Sink",
        verbPhrase: "can receive important messages",
        description: "Stores classified mail messages from Mail Agent.",
        requiredPermissions: ["view"],
        descriptor: POWERBOX_DESCRIPTORS.messageSink,
      },
    });
    const session = api.session();
    const url = new URL(request.url);

    try {
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const fulfillmentRoute = await fulfillment.serve(request);
      if (fulfillmentRoute) return fulfillmentRoute;

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

      if (session.sessionType === "request") return fulfillmentPage(fulfillment, request);

      return new Response(html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
