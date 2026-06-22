/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { Capability, RpcTarget, sandstorm } from "sandstorm:api";
import type { NativeAppRpcProxy, PowerboxFulfillmentApi, SandstormEnv } from "sandstorm:api";
import { POWERBOX_DESCRIPTORS } from "@mail-agent/protocol";
import type { MailEvent, MailEventPort, SubscriptionRequest } from "@mail-agent/protocol";

const RECEIVER_TOKEN_KEY = "mail-event-port-token";
const SUBSCRIPTION_KEY = "mail-feed-subscription";
const MAIL_FEED_ID = "dummy-mail-feed-v1";
const MAIL_FEED_TOKEN_KEY = "dummy-mail-feed-token";
const STATS_KEY = "dummy-email-producer-stats";

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

interface ProducerStats {
  sent: number;
  errors: number;
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

async function readStats(request: Request, env: Env): Promise<ProducerStats> {
  const stats = await sandstorm(request, env).storage().getJson<Partial<ProducerStats>>(STATS_KEY);
  return {
    sent: Math.max(0, Number(stats?.sent || 0)),
    errors: Math.max(0, Number(stats?.errors || 0)),
  };
}

async function incrementStats(
  request: Request,
  env: Env,
  increment: Partial<Record<keyof ProducerStats, number>>,
): Promise<void> {
  const stats = await readStats(request, env);
  await sandstorm(request, env).storage().putJson(STATS_KEY, {
    sent: stats.sent + (increment.sent || 0),
    errors: stats.errors + (increment.errors || 0),
  });
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

function rpc<T extends object>(capability: Capability): NativeAppRpcProxy<T> {
  return capability.rpc as NativeAppRpcProxy<T>;
}

class MailFeedTarget extends RpcTarget {
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {
    super();
  }

  async addReceiver(receiver: unknown, subscription: SubscriptionRequest): Promise<{
    ok: true;
    id: string;
  }> {
    const api = sandstorm(this.request, this.env);
    let receiverToken: string;
    if (receiver instanceof Capability) {
      receiverToken = await receiver.save({ label: "Mail classifier receiver" });
    } else if (typeof receiver === "string" && receiver.length > 0) {
      receiverToken = receiver;
    } else {
      throw new Error("receiver capability is required");
    }
    await api.storage().put(RECEIVER_TOKEN_KEY, receiverToken);
    await api.storage().putJson(SUBSCRIPTION_KEY, {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      request: JSON.parse(JSON.stringify(subscription)),
      receiver: {
        token: receiverToken,
        tokenOwner: receiver instanceof Capability ? "provider" : "subscriber",
      },
    });
    return { ok: true, id: "dummy-mail-feed-subscription" };
  }
}

async function ensureMailFeed(request: Request, env: Env): Promise<Capability> {
  const result = await sandstorm(request, env, durableCapabilities).exportDurable(MAIL_FEED_ID, {
    storageKey: MAIL_FEED_TOKEN_KEY,
    label: "Dummy mail feed",
  });
  return result.capability;
}

async function sendSample(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const sample = SAMPLES.find((item) => item.id === body.id);
  if (!sample) {
    await incrementStats(request, env, { errors: 1 });
    return jsonError(new Error("Unknown sample email"), 404);
  }

  const token = await sandstorm(request, env).storage().get(RECEIVER_TOKEN_KEY);
  if (!token) {
    await incrementStats(request, env, { errors: 1 });
    return jsonError(new Error("Mail classifier receiver is not connected"), 400);
  }

  try {
    return await sandstorm(request, env).use(token, async (capability) => {
      const receiver = rpc<MailEventPort>(capability);
      const event = sampleEvent(sample);
      const result = await receiver.deliver(event);
      await incrementStats(request, env, { sent: 1 });
      return Response.json({ ok: true, sample, event, result });
    });
  } catch (error) {
    await incrementStats(request, env, { errors: 1 });
    throw error;
  }
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  return {
    hasSubscriber: Boolean(await sandstorm(request, env).storage().get(RECEIVER_TOKEN_KEY)),
    hasMailFeedCapability: Boolean(await sandstorm(request, env).storage().get(MAIL_FEED_TOKEN_KEY)),
    subscription: await sandstorm(request, env).storage().getJson(SUBSCRIPTION_KEY),
    stats: await readStats(request, env),
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
      .header { align-items: start; display: flex; justify-content: space-between; gap: 1rem; }
      h1 { margin-bottom: 0; margin-top: 0; }
      h2 { font-size: 1rem; margin: 1.35rem 0 0.65rem; }
      .stats { display: flex; gap: 1rem; text-align: right; }
      .stat-label { color: #526173; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
      .stat-value { font-size: 1.25rem; font-weight: 650; line-height: 1.1; }
      button { border: 1px solid #205493; border-radius: 4px; background: #205493; color: white; cursor: pointer; font: inherit; padding: 0.45rem 0.7rem; }
      button.secondary { background: white; color: #205493; }
      button:disabled { cursor: wait; opacity: 0.65; }
      .controls { align-items: center; display: flex; gap: 0.4rem; margin: 0 0 0.75rem; }
      table { border-collapse: collapse; margin: 1rem 0; width: 100%; }
      th, td { border-bottom: 1px solid #d8dee6; padding: 0.55rem; text-align: left; vertical-align: top; }
      th { color: #526173; font-size: 0.85rem; font-weight: 600; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <div class="header">
        <h1>Dummy Email Producer</h1>
        <div class="stats">
          <div>
            <div class="stat-label">Sent</div>
            <div class="stat-value" id="sent-count">0</div>
          </div>
          <div>
            <div class="stat-label">Errors</div>
            <div class="stat-value" id="error-count">0</div>
          </div>
        </div>
      </div>
      <div class="controls">
        <button id="config-toggle" class="secondary" type="button">Show config</button>
      </div>
      <h2>Sample Emails</h2>
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
      <pre id="output" hidden></pre>
    </main>
    <script>
      const output = document.querySelector("#output");
      const table = document.querySelector("#samples");
      const sentCount = document.querySelector("#sent-count");
      const errorCount = document.querySelector("#error-count");
      const configToggle = document.querySelector("#config-toggle");
      let currentState = null;
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      function renderState(state) {
        currentState = state;
        sentCount.textContent = String(state.stats?.sent || 0);
        errorCount.textContent = String(state.stats?.errors || 0);
        show(state);
      }
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
              await refresh();
            } catch (error) {
              show({ ok: false, error: error.message || String(error) });
              await refresh();
            } finally {
              button.disabled = false;
            }
          });
          action.append(button);
          row.append(subject, from, body, action);
          return row;
        }));
        renderState(current);
      }
      configToggle.addEventListener("click", () => {
        output.hidden = !output.hidden;
        configToggle.textContent = output.hidden ? "Show config" : "Hide config";
        if (!output.hidden && currentState) show(currentState);
      });
      refresh().catch((error) => show({ ok: false, error: error.message || String(error) }));
    </script>
  </body>
</html>`;
}

const durableCapabilities = {
  capabilities: {
    [MAIL_FEED_ID]: (request: Request, env: SandstormEnv) => new MailFeedTarget(request, env as Env),
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
      title: "Dummy Mail Feed",
      description: "Provides a MailFeed that pushes selected sample emails to a subscriber receiver.",
      buttonLabel: "Use This Mail Feed",
      capability: () => ensureMailFeed(request, env),
      fulfill: {
        title: "Dummy Mail Feed",
        verbPhrase: "can send sample email events",
        description: "Provides a MailFeed that pushes selected sample emails to a subscriber receiver.",
        requiredPermissions: ["view"],
        descriptor: POWERBOX_DESCRIPTORS.mailFeed,
      },
    });
    const session = api.session();
    const url = new URL(request.url);

    try {
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const fulfillmentRoute = await fulfillment.serve(request);
      if (fulfillmentRoute) return fulfillmentRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/send") {
        return sendSample(request, env);
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
