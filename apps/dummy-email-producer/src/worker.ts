/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm } from "sandstorm:api";
import type { ClaimedCapability, SandstormEnv } from "sandstorm:api";
import { POWERBOX_DESCRIPTORS } from "@mail-agent/protocol";
import type { MailEvent, MailEventPort, SubscriptionRequest } from "@mail-agent/protocol";

const RECEIVER_TOKEN_KEY = "mail-event-port-token";
const SUBSCRIPTION_KEY = "mail-feed-subscription";
const MAIL_FEED_ID = "dummy-mail-feed-v1";
const MAIL_FEED_TOKEN_KEY = "dummy-mail-feed-token";

interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}

interface SampleEmail {
  id: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  body: string;
}

const SAMPLES: SampleEmail[] = [
  {
    id: "flight-change",
    fromName: "Aviary Airlines",
    fromAddress: "alerts@aviary.example",
    subject: "Urgent flight change requires confirmation",
    body: "Your return flight changed. Action required before 5 PM today to keep your seat assignment.",
  },
  {
    id: "invoice-overdue",
    fromName: "Northstar Billing",
    fromAddress: "billing@northstar.example",
    subject: "Invoice overdue",
    body: "Invoice MA-1042 is overdue. Please review the balance and submit payment by tomorrow.",
  },
  {
    id: "security-alert",
    fromName: "Account Security",
    fromAddress: "security@example.test",
    subject: "Security alert for your account",
    body: "A new device signed in. If this was not you, reset your password as soon as possible.",
  },
  {
    id: "newsletter",
    fromName: "Weekly Systems Digest",
    fromAddress: "digest@news.example",
    subject: "This week in systems",
    body: "Links, release notes, and a few longer reads for later.",
  },
  {
    id: "meeting-notes",
    fromName: "Priya Shah",
    fromAddress: "priya@example.test",
    subject: "Notes from planning",
    body: "Here are the notes from today's planning discussion. No action needed right now.",
  },
  {
    id: "password-reset",
    fromName: "Example Support",
    fromAddress: "support@example.test",
    subject: "Password reset requested",
    body: "We received a password reset request. The link expires in 15 minutes.",
  },
  {
    id: "deadline-reminder",
    fromName: "Grants Office",
    fromAddress: "grants@example.test",
    subject: "Deadline reminder",
    body: "The application deadline is tomorrow at noon. Missing documents must be uploaded today.",
  },
  {
    id: "receipt",
    fromName: "Cafe Register",
    fromAddress: "receipts@cafe.example",
    subject: "Your receipt",
    body: "Thanks for your purchase. Total: $8.42.",
  },
  {
    id: "package-delay",
    fromName: "Parcel Updates",
    fromAddress: "tracking@parcel.example",
    subject: "Package delayed",
    body: "Your package is delayed by one business day. No action is needed.",
  },
  {
    id: "contract-review",
    fromName: "Legal Desk",
    fromAddress: "legal@example.test",
    subject: "Action required: contract review",
    body: "Please review the attached contract changes before tomorrow's deadline.",
  },
];

function jsonError(error: unknown, status = 500): Response {
  return Response.json({
    ok: false,
    name: String((error as Error)?.name || "Error"),
    message: String((error as Error)?.message || error),
  }, { status });
}

function sampleEvent(sample: SampleEmail): MailEvent {
  const now = new Date().toISOString();
  return {
    metadata: {
      messageKey: `dummy:${sample.id}:${crypto.randomUUID()}`,
      messageId: `<${crypto.randomUUID()}@dummy.mail-agent.test>`,
      dedupeKey: `dummy:${sample.id}:${crypto.randomUUID()}`,
      subject: sample.subject,
      from: [{ name: sample.fromName, address: sample.fromAddress }],
      to: [{ name: "Mail Agent", address: "mail-agent@example.test" }],
      receivedAt: now,
    },
    textBody: sample.body,
  };
}

class MailFeedTarget extends RpcTarget {
  private request?: Request;
  private env?: Env;

  bind(request: Request, env: Env): this {
    this.request = request;
    this.env = env;
    return this;
  }

  private context(): { request: Request; env: Env } {
    if (!this.request || !this.env) {
      throw new Error("Dummy mail feed is not bound to a request");
    }
    return { request: this.request, env: this.env };
  }

  async addReceiver(receiverToken: string, subscription: SubscriptionRequest): Promise<{
    ok: true;
    id: string;
  }> {
    const { request, env } = this.context();
    const api = sandstorm(request, env);
    if (typeof receiverToken !== "string" || receiverToken.length === 0) {
      throw new Error("receiver token is required");
    }
    const receiver = await api.powerbox().restoreSaved(receiverToken);
    await receiver.drop();
    await api.storage().put(RECEIVER_TOKEN_KEY, receiverToken);
    await api.storage().putJson(SUBSCRIPTION_KEY, {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      request: JSON.parse(JSON.stringify(subscription)),
      receiver: {
        ok: true,
        type: "savedCapability",
        token: receiverToken,
        tokenEncoding: "base64url",
      },
    });
    return { ok: true, id: "dummy-mail-feed-subscription" };
  }
}

const mailFeedTarget = new MailFeedTarget();

async function ensureMailFeed(request: Request, env: Env): Promise<ClaimedCapability> {
  const result = await sandstorm(request, env).persistentCapability(mailFeedTarget.bind(request, env), {
    id: MAIL_FEED_ID,
    storageKey: MAIL_FEED_TOKEN_KEY,
    label: "Dummy mail feed",
  });
  return result.capability;
}

async function fulfillMailFeedRequest(request: Request, env: Env): Promise<Response> {
  const capability = await ensureMailFeed(request, env);
  const fulfill = await capability.fulfillRequest(request, {
    title: "Dummy Mail Feed",
    verbPhrase: "can send sample email events",
    description: "Provides a MailFeed that pushes selected sample emails to a subscriber receiver.",
    requiredPermissions: ["view"],
    descriptor: POWERBOX_DESCRIPTORS.mailFeed,
  });
  return Response.json({
    ok: true,
    fulfill,
    capability: JSON.parse(JSON.stringify(capability)),
  });
}

async function sendSample(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const sample = SAMPLES.find((item) => item.id === body.id);
  if (!sample) return jsonError(new Error("Unknown sample email"), 404);

  const token = await sandstorm(request, env).storage().get(RECEIVER_TOKEN_KEY);
  if (!token) return jsonError(new Error("Mail classifier receiver is not connected"), 400);

  const capability = await sandstorm(request, env).powerbox().restoreSaved(token);
  try {
    const receiver = capability.asRpc<MailEventPort>();
    const event = sampleEvent(sample);
    const result = await receiver.deliver(event);
    return Response.json({ ok: true, sample, event, result });
  } finally {
    await capability.drop();
  }
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  return {
    hasSubscriber: Boolean(await sandstorm(request, env).storage().get(RECEIVER_TOKEN_KEY)),
    hasMailFeedCapability: Boolean(await sandstorm(request, env).storage().get(MAIL_FEED_TOKEN_KEY)),
    subscription: await sandstorm(request, env).storage().getJson(SUBSCRIPTION_KEY),
    samples: SAMPLES.map(({ id, fromName, fromAddress, subject, body }) => ({
      id,
      fromName,
      fromAddress,
      subject,
      body,
    })),
  };
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Dummy Email Producer</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 2rem; }
      main { max-width: 64rem; }
      button { border: 1px solid #205493; border-radius: 4px; background: #205493; color: white; cursor: pointer; font: inherit; padding: 0.45rem 0.7rem; }
      button:disabled { cursor: wait; opacity: 0.65; }
      table { border-collapse: collapse; margin: 1rem 0; width: 100%; }
      th, td { border-bottom: 1px solid #d8dee6; padding: 0.55rem; text-align: left; vertical-align: top; }
      th { color: #526173; font-size: 0.85rem; font-weight: 600; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Dummy Email Producer</h1>
      <table>
        <thead>
          <tr>
            <th>Sample</th>
            <th>From</th>
            <th>Body</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="samples"></tbody>
      </table>
      <pre id="output">Ready.</pre>
    </main>
    <script>
      const output = document.querySelector("#output");
      const table = document.querySelector("#samples");
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      async function post(path, body) {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error(result.message || result.error || "Request failed");
        return result;
      }
      async function refresh() {
        const current = await (await fetch("/api/state")).json();
        table.replaceChildren(...current.samples.map((sample) => {
          const row = document.createElement("tr");
          const subject = document.createElement("td");
          subject.textContent = sample.subject;
          const from = document.createElement("td");
          from.textContent = sample.fromName + " <" + sample.fromAddress + ">";
          const body = document.createElement("td");
          body.textContent = sample.body;
          const action = document.createElement("td");
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Deliver";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              show(await post("/api/send", { id: sample.id }));
            } catch (error) {
              show({ ok: false, error: error.message || String(error) });
            } finally {
              button.disabled = false;
            }
          });
          action.append(button);
          row.append(subject, from, body, action);
          return row;
        }));
        show(current);
      }
      refresh().catch((error) => show({ ok: false, error: error.message || String(error) }));
    </script>
  </body>
</html>`;
}

function powerboxRequestHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Dummy Mail Feed</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 1.25rem; }
      main { max-width: 34rem; }
      button { border: 1px solid #205493; border-radius: 4px; background: #205493; color: white; cursor: pointer; font: inherit; padding: 0.45rem 0.7rem; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 0.75rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Dummy Mail Feed</h1>
      <button id="provide" type="button">Use This Mail Feed</button>
      <pre id="output">Ready.</pre>
    </main>
    <script>
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
      api.registerCapability(mailFeedTarget.bind(request, env), {
        id: MAIL_FEED_ID,
      });

      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/powerbox/fulfill") {
        return fulfillMailFeedRequest(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/send") {
        return sendSample(request, env);
      }

      return new Response(session.sessionType === "request" ? powerboxRequestHtml() : html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
