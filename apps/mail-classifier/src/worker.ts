/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { Capability, NativeAppRpcProxy, SandstormEnv } from "sandstorm:api";
import { POWERBOX_DESCRIPTORS } from "@mail-agent/protocol";
import type {
  ClassificationDecision,
  ConversationalLlm,
  MailFeed,
  MailEvent,
  Message,
  MessageSink,
  SenderInstruction,
} from "@mail-agent/protocol";

const MAIL_FEED_TOKEN_KEY = "mail-feed-token";
const LLM_TOKEN_KEY = "llm-token";
const MESSAGES_TOKEN_KEY = "messages-token";
const MAIL_EVENT_PORT_ID = "mail-event-port-v1";
const MAIL_EVENT_PORT_TOKEN_KEY = "mail-event-port-token";
const SENDER_INSTRUCTIONS_KEY = "sender-instructions";
const PROCESSED_DEDUPE_KEYS = "processed-dedupe-keys";
const SUBSCRIPTION_KEY = "mail-feed-subscription";
const STATS_KEY = "mail-classifier-stats";

interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}

interface ClassifierStats {
  incomingEmails: number;
  outgoingMessages: number;
}

function jsonError(error: unknown, status = 500): Response {
  return Response.json({
    ok: false,
    name: String((error as Error)?.name || "Error"),
    message: String((error as Error)?.message || error),
  }, { status });
}

function eventDedupeKey(event: MailEvent): string {
  return event.metadata.dedupeKey || event.metadata.messageKey || event.metadata.messageId || crypto.randomUUID();
}

function primarySender(event: MailEvent): string {
  return event.metadata.from?.[0]?.address?.toLowerCase() || "";
}

function senderDomain(sender: string): string {
  return sender.includes("@") ? sender.split("@").pop() || "" : "";
}

async function readDedupe(request: Request, env: Env): Promise<string[]> {
  return (await sandstorm(request, env).storage().getJson<string[]>(PROCESSED_DEDUPE_KEYS)) || [];
}

async function markDedupe(request: Request, env: Env, key: string): Promise<void> {
  const current = await readDedupe(request, env);
  await sandstorm(request, env).storage().putJson(PROCESSED_DEDUPE_KEYS, [key, ...current.filter((item) => item !== key)].slice(0, 2000));
}

async function readInstructions(request: Request, env: Env): Promise<SenderInstruction[]> {
  return (await sandstorm(request, env).storage().getJson<SenderInstruction[]>(SENDER_INSTRUCTIONS_KEY)) || [];
}

async function readStats(request: Request, env: Env): Promise<ClassifierStats> {
  const stats = await sandstorm(request, env).storage().getJson<Partial<ClassifierStats>>(STATS_KEY);
  return {
    incomingEmails: Math.max(0, Number(stats?.incomingEmails || 0)),
    outgoingMessages: Math.max(0, Number(stats?.outgoingMessages || 0)),
  };
}

async function incrementStats(
  request: Request,
  env: Env,
  increment: Partial<Record<keyof ClassifierStats, number>>,
): Promise<ClassifierStats> {
  const stats = await readStats(request, env);
  const next = {
    incomingEmails: stats.incomingEmails + (increment.incomingEmails || 0),
    outgoingMessages: stats.outgoingMessages + (increment.outgoingMessages || 0),
  };
  await sandstorm(request, env).storage().putJson(STATS_KEY, next);
  return next;
}

function matchingInstruction(event: MailEvent, instructions: SenderInstruction[]): SenderInstruction | undefined {
  const sender = primarySender(event);
  const domain = senderDomain(sender);
  return instructions.find((instruction) => instruction.sender.toLowerCase() === sender) ||
    instructions.find((instruction) => instruction.sender.toLowerCase() === domain) ||
    instructions.find((instruction) => instruction.sender === "*");
}

function parseDecision(value: unknown, event: MailEvent): ClassificationDecision {
  const maybe = value as Partial<ClassificationDecision>;
  return {
    important: Boolean(maybe.important),
    confidence: typeof maybe.confidence === "number" ? maybe.confidence : 0.5,
    summary: typeof maybe.summary === "string" && maybe.summary
      ? maybe.summary
      : (event.metadata.subject || "Important email"),
    reason: typeof maybe.reason === "string" ? maybe.reason : "No reason supplied.",
    labels: Array.isArray(maybe.labels) ? maybe.labels.map((label) => String(label)).slice(0, 20) : [],
  };
}

function localDecision(event: MailEvent, instruction?: SenderInstruction): ClassificationDecision {
  if (instruction?.policy === "always-important") {
    return {
      important: true,
      confidence: 1,
      summary: event.metadata.subject || "Important email",
      reason: instruction.notes || "Sender is configured as always important.",
      labels: ["sender-rule"],
    };
  }
  if (instruction?.policy === "never-important") {
    return {
      important: false,
      confidence: 1,
      summary: event.metadata.subject || "Ignored email",
      reason: instruction.notes || "Sender is configured as never important.",
      labels: ["sender-rule"],
    };
  }
  const body = `${event.metadata.subject || ""}\n${event.textBody || ""}`.toLowerCase();
  const important = /\b(deadline|urgent|asap|action required|invoice|flight|security|password|overdue)\b/.test(body);
  return {
    important,
    confidence: important ? 0.7 : 0.4,
    summary: event.metadata.subject || (important ? "Email needs review" : "Email classified as routine"),
    reason: important ? "Matched local priority terms." : "No local priority terms matched.",
    labels: important ? ["local-rule"] : [],
  };
}

function messageFromDecision(event: MailEvent, decision: ClassificationDecision, dedupeKey: string): Message {
  return {
    id: crypto.randomUUID(),
    source: "mail",
    title: event.metadata.subject || decision.summary || "Important email",
    body: decision.summary,
    priority: decision.confidence >= 0.8 ? "high" : "normal",
    createdAt: new Date().toISOString(),
    dedupeKey,
    sourceRef: {
      messageKey: event.metadata.messageKey,
      messageId: event.metadata.messageId,
      from: event.metadata.from || [],
      receivedAt: event.metadata.receivedAt,
    },
    labels: decision.labels,
  };
}

function rpc<T extends object>(capability: Capability): NativeAppRpcProxy<T> {
  return capability.rpc as NativeAppRpcProxy<T>;
}

class MailClassifierPortTarget extends RpcTarget {
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {
    super();
  }

  async deliver(event: MailEvent): Promise<{ ok: true; ignored?: boolean; messageId?: string }> {
    const { request, env } = this;
    await incrementStats(request, env, { incomingEmails: 1 });
    const dedupeKey = eventDedupeKey(event);
    const seen = await readDedupe(request, env);
    if (seen.includes(dedupeKey)) return { ok: true, ignored: true };

    const api = sandstorm(request, env, durableCapabilities);
    const instructions = await readInstructions(request, env);
    const instruction = matchingInstruction(event, instructions);
    let decision = localDecision(event, instruction);

    if (!instruction || instruction.policy === "llm-decides") {
      const llmToken = await api.storage().get(LLM_TOKEN_KEY);
      if (llmToken) {
        await api.use(llmToken, async (capability) => {
          const llm = rpc<ConversationalLlm>(capability);
          decision = parseDecision(await llm.completeJson({
            responseFormat: "json",
            messages: [{
              role: "system",
              content: "Classify whether this email is important. Return JSON with important, confidence, summary, reason, labels.",
            }, {
              role: "user",
              content: JSON.stringify({
                from: event.metadata.from,
                subject: event.metadata.subject,
                receivedAt: event.metadata.receivedAt,
                instruction,
                textBody: event.textBody,
              }),
            }],
          }), event);
        });
      }
    }

    if (!decision.important) {
      await markDedupe(request, env, dedupeKey);
      return { ok: true, ignored: true };
    }

    const messagesToken = await api.storage().get(MESSAGES_TOKEN_KEY);
    if (!messagesToken) {
      throw new Error("messages-token is not configured");
    }

    const message = messageFromDecision(event, decision, dedupeKey);
    return api.use(messagesToken, async (capability) => {
      const sink = rpc<MessageSink>(capability);
      const added = await sink.addMessage(message);
      await incrementStats(request, env, { outgoingMessages: 1 });
      await markDedupe(request, env, dedupeKey);
      return { ok: true, messageId: added.id };
    });
  }
}

async function ensurePort(request: Request, env: Env): Promise<{
  capability: Capability;
  token: string;
}> {
  const result = await sandstorm(request, env, durableCapabilities).exportDurable(MAIL_EVENT_PORT_ID, {
    storageKey: MAIL_EVENT_PORT_TOKEN_KEY,
    label: "Mail classifier receiver",
  });
  return {
    capability: result.capability,
    token: result.token,
  };
}

async function subscribeMailFeed(request: Request, env: Env): Promise<Response> {
  const api = sandstorm(request, env, durableCapabilities);
  const mailFeedToken = await api.storage().get(MAIL_FEED_TOKEN_KEY);
  if (!mailFeedToken) throw new Error("mail-feed-token is not configured");

  const receiver = await ensurePort(request, env);
  try {
    const subscription = await api.use(mailFeedToken, async (capability) => {
      const mailFeed = rpc<MailFeed>(capability);
      return mailFeed.addReceiver(receiver.capability, {
        filter: {
          toContains: "",
          fromContains: "",
          subjectContains: "",
          includeAttachments: false,
        },
        start: "fromNow",
        payload: "metadataAndText",
      });
    });
    await api.storage().putJson(SUBSCRIPTION_KEY, JSON.parse(JSON.stringify(subscription)));
    return Response.json({ ok: true, subscription });
  } finally {
    await receiver.capability.drop();
  }
}

async function upsertInstruction(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const instruction: SenderInstruction = {
    sender: validate.string(body.sender || "*", "sender", { maxLength: 300 }).toLowerCase(),
    policy: body.policy === "always-important" || body.policy === "never-important"
      ? body.policy
      : "llm-decides",
    notes: body.notes ? validate.string(body.notes, "notes", { maxLength: 2000 }) : "",
    updatedAt: new Date().toISOString(),
  };
  const current = await readInstructions(request, env);
  await sandstorm(request, env).storage().putJson(SENDER_INSTRUCTIONS_KEY, JSON.parse(JSON.stringify([
    instruction,
    ...current.filter((item) => item.sender !== instruction.sender),
  ])));
  return Response.json({ ok: true, instruction });
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  const store = sandstorm(request, env).storage();
  const session = sandstorm(request, env).session();
  return {
    sessionType: session.sessionType,
    hasMailFeed: Boolean(await store.get(MAIL_FEED_TOKEN_KEY)),
    hasLlm: Boolean(await store.get(LLM_TOKEN_KEY)),
    hasMessages: Boolean(await store.get(MESSAGES_TOKEN_KEY)),
    hasPort: Boolean(await store.get(MAIL_EVENT_PORT_TOKEN_KEY)),
    subscription: await store.getJson(SUBSCRIPTION_KEY),
    instructions: await readInstructions(request, env),
    stats: await readStats(request, env),
    processedCount: (await readDedupe(request, env)).length,
    portCapabilityId: MAIL_EVENT_PORT_ID,
  };
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mail Classifier</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 2rem; }
      .header { align-items: start; display: flex; justify-content: space-between; gap: 1rem; }
      .header h1 { margin-bottom: 0; margin-top: 0; }
      .stats { display: flex; gap: 1rem; text-align: right; }
      .stat-label { color: #526173; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
      .stat-value { font-size: 1.25rem; font-weight: 650; line-height: 1.1; }
      h2 { font-size: 1rem; margin: 1.35rem 0 0.65rem; }
      button { border: 1px solid #6840a0; border-radius: 4px; background: #6840a0; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      button.secondary { background: white; color: #6840a0; }
      .controls { align-items: center; display: flex; gap: 0.4rem; margin: 0 0 0.75rem; }
      .grants { display: grid; gap: 0.75rem; margin: 0 0 1rem; }
      .grant-row { border-bottom: 1px solid #d8dee6; padding: 0 0 0.75rem; }
      .grant-title { color: #526173; font-size: 0.82rem; font-weight: 600; margin: 0 0 0.35rem; text-transform: uppercase; }
      .grant-body { align-items: center; display: flex; justify-content: space-between; gap: 1rem; }
      .grant-status { color: #172033; }
      .grant-row button { font-size: 0.86rem; margin: 0; padding: 0.28rem 0.55rem; }
      input, select { border: 1px solid #a8b3c1; border-radius: 4px; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.4rem; }
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
        <h1>Mail Classifier</h1>
        <div class="stats">
          <div>
            <div class="stat-label">Incoming</div>
            <div class="stat-value" id="incoming-count">0</div>
          </div>
          <div>
            <div class="stat-label">Outgoing</div>
            <div class="stat-value" id="outgoing-count">0</div>
          </div>
        </div>
      </div>
      <h2>Capabilities</h2>
      <section class="grants" id="grants"></section>
      <div class="controls">
        <button id="sample" type="button">Deliver Sample</button>
        <button id="config-toggle" class="secondary" type="button">Show config</button>
      </div>
      <h2>Incoming Mail Rules</h2>
      <form id="instruction">
        <input name="sender" placeholder="sender or domain" value="*">
        <select name="policy">
          <option value="llm-decides">LLM decides</option>
          <option value="always-important">Always important</option>
          <option value="never-important">Never important</option>
        </select>
        <input name="notes" placeholder="notes">
        <button type="submit">Save Rule</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Sender</th>
            <th>Policy</th>
            <th>Notes</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody id="rules-body"></tbody>
      </table>
      <pre id="output" hidden></pre>
    </main>
    <script type="module">
      import { grantStatus, requestGrant, revokeGrant } from "/__sandstorm/powerbox-grants/client.js";
      import { newSandstormRpcSession } from "./rpc-client.js";
      const output = document.querySelector("#output");
      const grants = document.querySelector("#grants");
      const incomingCount = document.querySelector("#incoming-count");
      const outgoingCount = document.querySelector("#outgoing-count");
      const rulesBody = document.querySelector("#rules-body");
      const configToggle = document.querySelector("#config-toggle");
      let currentState = null;
      const grantDefinitions = [
        { id: "mailFeed", title: "Mail feed", afterConnect: async () => post("/api/subscribe") },
        { id: "llm", title: "Conversational LLM" },
        { id: "messages", title: "Message sink" },
      ];
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      function renderRules(instructions) {
        if (!instructions.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.className = "empty";
          cell.colSpan = 4;
          cell.textContent = "No incoming mail rules.";
          row.append(cell);
          rulesBody.replaceChildren(row);
          return;
        }
        rulesBody.replaceChildren(...instructions.map((instruction) => {
          const row = document.createElement("tr");
          const sender = document.createElement("td");
          sender.textContent = instruction.sender || "";
          const policy = document.createElement("td");
          policy.textContent = instruction.policy || "";
          const notes = document.createElement("td");
          notes.textContent = instruction.notes || "";
          const updated = document.createElement("td");
          updated.textContent = instruction.updatedAt ? new Date(instruction.updatedAt).toLocaleString() : "";
          row.append(sender, policy, notes, updated);
          return row;
        }));
      }
      function renderState(state) {
        currentState = state;
        incomingCount.textContent = String(state.stats?.incomingEmails || 0);
        outgoingCount.textContent = String(state.stats?.outgoingMessages || 0);
        renderRules(Array.isArray(state.instructions) ? state.instructions : []);
        show(state);
      }
      async function refreshState() {
        const state = await (await fetch("/api/state")).json();
        renderState(state);
      }
      async function post(path, body) {
        const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
        return response.json();
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
            if (grant.status.connected) {
              show(await revokeGrant(grant.id));
            } else {
              const connected = await requestGrant(grant.id);
              const afterConnect = grant.afterConnect ? await grant.afterConnect() : undefined;
              show({ ok: true, connected, afterConnect });
            }
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
      document.querySelector("#sample").addEventListener("click", async () => {
        using rpc = newSandstormRpcSession();
        show(await rpc.deliver({
          metadata: {
            messageKey: crypto.randomUUID(),
            dedupeKey: crypto.randomUUID(),
            subject: "Urgent flight change",
            from: [{ name: "Airline", address: "alerts@example.test" }],
            receivedAt: new Date().toISOString()
          },
          textBody: "Action required before tomorrow."
        }));
        await refreshState();
      });
      configToggle.addEventListener("click", () => {
        output.hidden = !output.hidden;
        configToggle.textContent = output.hidden ? "Show config" : "Hide config";
        if (!output.hidden && currentState) show(currentState);
      });
      document.querySelector("#instruction").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        show(await post("/api/instructions", Object.fromEntries(form.entries())));
        await refreshState();
      });
      await refreshGrantRows();
      await refreshState();
    </script>
  </body>
</html>`;
}

const durableCapabilities = {
  capabilities: {
    [MAIL_EVENT_PORT_ID]: (request: Request, env: SandstormEnv) =>
      new MailClassifierPortTarget(request, env as Env),
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = sandstorm(request, env, durableCapabilities);
    const grants = api.powerboxGrants({
      grants: {
        mailFeed: {
          title: "Mail feed",
          description: "Used to subscribe the classifier to incoming mail events.",
          storageKey: MAIL_FEED_TOKEN_KEY,
          descriptor: POWERBOX_DESCRIPTORS.mailFeed,
          saveLabel: { defaultText: "Mail feed" },
          save: { label: "Mail feed" },
        },
        llm: {
          title: "Conversational LLM",
          description: "Used to classify messages when sender rules ask the LLM to decide.",
          storageKey: LLM_TOKEN_KEY,
          descriptor: POWERBOX_DESCRIPTORS.conversationalLlm,
          saveLabel: { defaultText: "Conversational LLM" },
          save: { label: "Conversational LLM" },
        },
        messages: {
          title: "Message sink",
          description: "Used to store important classified messages.",
          storageKey: MESSAGES_TOKEN_KEY,
          descriptor: POWERBOX_DESCRIPTORS.messageSink,
          saveLabel: { defaultText: "Message sink" },
          save: { label: "Message sink" },
        },
      },
    });
    const url = new URL(request.url);

    try {
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const grantRoute = await grants.serve(request);
      if (grantRoute) return grantRoute;

      const rpcRoute = await api.serveRpc(() => new MailClassifierPortTarget(request, env));
      if (rpcRoute) return rpcRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/subscribe") {
        return subscribeMailFeed(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/instructions") {
        return upsertInstruction(request, env);
      }

      return new Response(html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
