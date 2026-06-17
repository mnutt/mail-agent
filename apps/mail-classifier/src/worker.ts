/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { ClaimedCapability, SandstormEnv } from "sandstorm:api";
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

class MailClassifierPortTarget extends RpcTarget {
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
      throw new Error("Mail classifier receiver is not bound to a request");
    }
    return { request: this.request, env: this.env };
  }

  async deliver(event: MailEvent): Promise<{ ok: true; ignored?: boolean; messageId?: string }> {
    const { request, env } = this.context();
    const dedupeKey = eventDedupeKey(event);
    const seen = await readDedupe(request, env);
    if (seen.includes(dedupeKey)) return { ok: true, ignored: true };

    const api = sandstorm(request, env);
    const instructions = await readInstructions(request, env);
    const instruction = matchingInstruction(event, instructions);
    let decision = localDecision(event, instruction);

    const llmToken = await api.storage().get(LLM_TOKEN_KEY);
    if (llmToken && (!instruction || instruction.policy === "llm-decides")) {
      const llmCap = await api.powerbox().restoreSaved(llmToken);
      try {
        const llm = llmCap.asRpc<ConversationalLlm>();
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
      } finally {
        await llmCap.drop();
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
    const messagesCap = await api.powerbox().restoreSaved(messagesToken);
    try {
      const sink = messagesCap.asRpc<MessageSink>();
      const added = await sink.addMessage(message);
      await markDedupe(request, env, dedupeKey);
      return { ok: true, messageId: added.id };
    } finally {
      await messagesCap.drop();
    }
  }
}

const mailClassifierPortTarget = new MailClassifierPortTarget();

async function ensurePort(request: Request, env: Env): Promise<{ capability: ClaimedCapability; token: string }> {
  const result = await sandstorm(request, env).persistentCapability(
    mailClassifierPortTarget.bind(request, env),
    {
      id: MAIL_EVENT_PORT_ID,
      storageKey: MAIL_EVENT_PORT_TOKEN_KEY,
      label: "Mail classifier receiver",
    },
  );
  return {
    capability: result.capability,
    token: result.token,
  };
}

async function claimCapability(
  request: Request,
  env: Env,
  storageKey: string,
  label: string,
): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const claimed = await sandstorm(request, env).powerbox().claimAndStoreRequest(body, {
    storageKey,
    label,
  });
  await claimed.capability.drop();
  return Response.json({
    ok: true,
    storageKey,
    saved: JSON.parse(JSON.stringify(claimed.saved)),
  });
}

async function subscribeMailFeed(request: Request, env: Env): Promise<Response> {
  const api = sandstorm(request, env);
  const mailFeedToken = await api.storage().get(MAIL_FEED_TOKEN_KEY);
  if (!mailFeedToken) throw new Error("mail-feed-token is not configured");

  const receiver = await ensurePort(request, env);
  const mailFeedCap = await api.powerbox().restoreSaved(mailFeedToken);
  try {
    const mailFeed = mailFeedCap.asRpc<MailFeed>();
    const subscription = await mailFeed.addReceiver(receiver.token, {
      filter: {
        toContains: "",
        fromContains: "",
        subjectContains: "",
        includeAttachments: false,
      },
      start: "fromNow",
      payload: "metadataAndText",
    });
    await api.storage().putJson(SUBSCRIPTION_KEY, JSON.parse(JSON.stringify(subscription)));
    return Response.json({ ok: true, subscription });
  } finally {
    await mailFeedCap.drop();
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
      main { max-width: 62rem; }
      button { border: 1px solid #6840a0; border-radius: 4px; background: #6840a0; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      input, select { border: 1px solid #a8b3c1; border-radius: 4px; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.4rem; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Mail Classifier</h1>
      <button id="mail-feed" type="button">Connect Mail Feed</button>
      <button id="llm" type="button">Connect LLM</button>
      <button id="messages" type="button">Connect Messages</button>
      <button id="sample" type="button">Deliver Sample</button>
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
      <pre id="output">Ready.</pre>
    </main>
    <script type="module">
      import { requestProviderPowerbox, newSandstormRpcSession } from "./rpc-client.js";
      const descriptors = ${JSON.stringify(POWERBOX_DESCRIPTORS)};
      const output = document.querySelector("#output");
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      async function post(path, body) {
        const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
        return response.json();
      }
      async function connectProvider(path, descriptor, label) {
        const requested = await requestProviderPowerbox({
          descriptor,
          saveLabel: { defaultText: label },
        });
        show(await post(path, requested));
      }
      async function connectMailFeed() {
        const requested = await requestProviderPowerbox({
          descriptor: descriptors.mailFeed,
          saveLabel: { defaultText: "Mail feed" },
        });
        const claimed = await post("/api/mail-feed/claim", requested);
        const subscribed = await post("/api/subscribe");
        show({ ok: true, claimed, subscribed });
      }
      document.querySelector("#mail-feed").addEventListener("click", () => connectMailFeed().catch((error) =>
        show({ ok: false, error: error.message || String(error) })));
      document.querySelector("#llm").addEventListener("click", () =>
        connectProvider("/api/llm/claim", descriptors.conversationalLlm, "Conversational LLM"));
      document.querySelector("#messages").addEventListener("click", () =>
        connectProvider("/api/messages/claim", descriptors.messageSink, "Message sink"));
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
      });
      document.querySelector("#instruction").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        show(await post("/api/instructions", Object.fromEntries(form.entries())));
      });
      show(await (await fetch("/api/state")).json());
    </script>
  </body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = sandstorm(request, env);
    const url = new URL(request.url);

    try {
      api.registerCapability(mailClassifierPortTarget.bind(request, env), {
        id: MAIL_EVENT_PORT_ID,
      });

      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const rpcRoute = await api.serveRpc(() => mailClassifierPortTarget.bind(request, env));
      if (rpcRoute) return rpcRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/mail-feed/claim") {
        return claimCapability(request, env, MAIL_FEED_TOKEN_KEY, "Mail feed");
      }
      if (request.method === "POST" && url.pathname === "/api/llm/claim") {
        return claimCapability(request, env, LLM_TOKEN_KEY, "Conversational LLM");
      }
      if (request.method === "POST" && url.pathname === "/api/messages/claim") {
        return claimCapability(request, env, MESSAGES_TOKEN_KEY, "Message sink");
      }
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
