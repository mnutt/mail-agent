/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { Capability, SandstormEnv } from "sandstorm:api";
import type { PushRequest, PushResult } from "@mail-agent/protocol";

const PUSH_CAPABILITY_ID = "push-notification-v1";
const PUSH_CAPABILITY_TOKEN_KEY = "push-notification-token";
const APNS_TOKEN_KEY = "apns-outbound-http-token";
const FCM_TOKEN_KEY = "fcm-outbound-http-token";
const DEVICES_KEY = "devices";
const ATTEMPTS_KEY = "delivery-attempts";

interface Env extends SandstormEnv {
  STORAGE: SandstormEnv["STORAGE"];
}

interface DeviceRegistration {
  id: string;
  platform: "apns" | "fcm";
  token: string;
  label?: string;
  enabled: boolean;
  updatedAt: string;
}

interface DeliveryAttempt {
  id: string;
  notificationId: string;
  deviceId: string;
  platform: "apns" | "fcm";
  ok: boolean;
  createdAt: string;
  error?: string;
}

function jsonError(error: unknown, status = 500): Response {
  return Response.json({
    ok: false,
    name: String((error as Error)?.name || "Error"),
    message: String((error as Error)?.message || error),
  }, { status });
}

async function readDevices(request: Request, env: Env): Promise<DeviceRegistration[]> {
  return (await sandstorm(request, env).storage().getJson<DeviceRegistration[]>(DEVICES_KEY)) || [];
}

async function writeDevices(request: Request, env: Env, devices: DeviceRegistration[]): Promise<void> {
  await sandstorm(request, env).storage().putJson(DEVICES_KEY, JSON.parse(JSON.stringify(devices)));
}

async function readAttempts(request: Request, env: Env): Promise<DeliveryAttempt[]> {
  return (await sandstorm(request, env).storage().getJson<DeliveryAttempt[]>(ATTEMPTS_KEY)) || [];
}

async function recordAttempts(request: Request, env: Env, attempts: DeliveryAttempt[]): Promise<void> {
  const store = sandstorm(request, env).storage();
  const current = await readAttempts(request, env);
  await store.putJson(ATTEMPTS_KEY, JSON.parse(JSON.stringify([...attempts, ...current].slice(0, 500))));
}

class PushNotificationTarget extends RpcTarget {
  constructor(
    private readonly request: Request,
    private readonly env: Env,
  ) {
    super();
  }

  async sendPushNotification(notification: PushRequest): Promise<PushResult> {
    const clean = {
      id: validate.string(notification.id || crypto.randomUUID(), "id", { maxLength: 160 }),
      title: validate.string(notification.title || "Message", "title", { maxLength: 120 }),
      body: validate.string(notification.body || "", "body", { maxLength: 300 }),
      urgency: notification.urgency === "high" ? "high" : "normal",
      collapseKey: notification.collapseKey,
      deepLink: notification.deepLink,
    };
    const devices = (await readDevices(this.request, this.env)).filter((device) => device.enabled);
    const attempts: DeliveryAttempt[] = [];
    const errors: string[] = [];

    for (const device of devices) {
      const tokenKey = device.platform === "apns" ? APNS_TOKEN_KEY : FCM_TOKEN_KEY;
      const hasProvider = Boolean(await sandstorm(this.request, this.env).storage().get(tokenKey));
      const ok = hasProvider;
      const error = hasProvider ? undefined : `missing ${device.platform} outbound HTTP grant`;
      if (error) errors.push(`${device.id}: ${error}`);
      attempts.push({
        id: crypto.randomUUID(),
        notificationId: clean.id,
        deviceId: device.id,
        platform: device.platform,
        ok,
        error,
        createdAt: new Date().toISOString(),
      });
    }

    await recordAttempts(this.request, this.env, attempts);
    return {
      ok: true,
      attempted: attempts.length,
      delivered: attempts.filter((attempt) => attempt.ok).length,
      errors,
    };
  }
}

async function ensureCapability(request: Request, env: Env): Promise<{
  capability: Capability;
  token: string;
}> {
  const result = await sandstorm(request, env, durableCapabilities).exportDurable(PUSH_CAPABILITY_ID, {
    storageKey: PUSH_CAPABILITY_TOKEN_KEY,
    label: "Mobile push notification sender",
  });
  return {
    capability: result.capability,
    token: result.token,
  };
}

async function upsertDevice(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const device: DeviceRegistration = {
    id: body.id ? validate.string(body.id, "id", { maxLength: 160 }) : crypto.randomUUID(),
    platform: body.platform === "apns" ? "apns" : "fcm",
    token: validate.string(body.token || "", "token", { maxLength: 4096 }),
    label: body.label ? validate.string(body.label, "label", { maxLength: 120 }) : undefined,
    enabled: body.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  const devices = await readDevices(request, env);
  await writeDevices(request, env, [
    device,
    ...devices.filter((existing) => existing.id !== device.id),
  ]);
  return Response.json({ ok: true, device });
}

async function state(request: Request, env: Env): Promise<Record<string, unknown>> {
  const store = sandstorm(request, env).storage();
  const attempts = await readAttempts(request, env);
  return {
    capabilityId: PUSH_CAPABILITY_ID,
    devices: await readDevices(request, env),
    stats: {
      sent: attempts.filter((attempt) => attempt.ok).length,
      errors: attempts.filter((attempt) => !attempt.ok).length,
    },
    hasApnsOutboundHttp: Boolean(await store.get(APNS_TOKEN_KEY)),
    hasFcmOutboundHttp: Boolean(await store.get(FCM_TOKEN_KEY)),
    hasPushCapabilityToken: Boolean(await store.get(PUSH_CAPABILITY_TOKEN_KEY)),
  };
}

function html(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Mobile Notifications</title>
    <style>
      body { color: #172033; font: 14px/1.45 system-ui, sans-serif; margin: 2rem; }
      .header { align-items: start; display: flex; justify-content: space-between; gap: 1rem; }
      h1 { margin-bottom: 0; margin-top: 0; }
      .stats { display: flex; gap: 1rem; text-align: right; }
      .stat-label { color: #526173; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
      .stat-value { font-size: 1.25rem; font-weight: 650; line-height: 1.1; }
      h2 { font-size: 1rem; margin: 1.35rem 0 0.65rem; }
      button { border: 1px solid #6f4e00; border-radius: 4px; background: #6f4e00; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      button.secondary { background: white; color: #6f4e00; }
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
        <h1>Mobile Notifications</h1>
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
      <h2>Capabilities</h2>
      <section class="grants" id="grants"></section>
      <div class="controls">
        <button id="capability" type="button">Create Push Capability</button>
        <button id="test" type="button">Test Push</button>
        <button id="config-toggle" class="secondary" type="button">Show config</button>
      </div>
      <h2>Registered Devices</h2>
      <form id="device">
        <select name="platform"><option value="apns">APNs</option><option value="fcm">FCM</option></select>
        <input name="token" placeholder="device token">
        <input name="label" placeholder="label">
        <button type="submit">Add Device</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Platform</th>
            <th>Status</th>
            <th>Token</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody id="devices-body"></tbody>
      </table>
      <pre id="output" hidden></pre>
    </main>
    <script type="module">
      import { grantStatus, requestGrant, revokeGrant } from "/__sandstorm/powerbox-grants/client.js";
      import { newSandstormRpcSession } from "./rpc-client.js";
      const output = document.querySelector("#output");
      const grants = document.querySelector("#grants");
      const devicesBody = document.querySelector("#devices-body");
      const configToggle = document.querySelector("#config-toggle");
      const sentCount = document.querySelector("#sent-count");
      const errorCount = document.querySelector("#error-count");
      let currentState = null;
      const grantDefinitions = [
        { id: "apns", title: "Apple Push Notifications" },
        { id: "fcm", title: "Firebase Cloud Messaging" },
      ];
      const show = (value) => output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      function shortToken(token) {
        if (!token) return "";
        return token.length <= 18 ? token : token.slice(0, 8) + "..." + token.slice(-6);
      }
      function renderDevices(devices) {
        if (!devices.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.className = "empty";
          cell.colSpan = 5;
          cell.textContent = "No registered devices.";
          row.append(cell);
          devicesBody.replaceChildren(row);
          return;
        }
        devicesBody.replaceChildren(...devices.map((device) => {
          const row = document.createElement("tr");
          const label = document.createElement("td");
          label.textContent = device.label || device.id || "";
          const platform = document.createElement("td");
          platform.textContent = device.platform || "";
          const status = document.createElement("td");
          status.textContent = device.enabled === false ? "disabled" : "enabled";
          const token = document.createElement("td");
          token.textContent = shortToken(device.token || "");
          const updated = document.createElement("td");
          updated.textContent = device.updatedAt ? new Date(device.updatedAt).toLocaleString() : "";
          row.append(label, platform, status, token, updated);
          return row;
        }));
      }
      function renderState(state) {
        currentState = state;
        sentCount.textContent = String(state.stats?.sent || 0);
        errorCount.textContent = String(state.stats?.errors || 0);
        renderDevices(Array.isArray(state.devices) ? state.devices : []);
        show(state);
      }
      async function refreshState() {
        const state = await (await fetch("/api/state")).json();
        renderState(state);
      }
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
      document.querySelector("#capability").addEventListener("click", async () => {
        await run(() => post("/api/capability"));
        await refreshState();
      });
      document.querySelector("#test").addEventListener("click", async () => {
        await run(async () => {
          using rpc = newSandstormRpcSession();
          return await rpc.sendPushNotification({ id: crypto.randomUUID(), title: "Test", body: "Delivery check", urgency: "normal" });
        });
        await refreshState();
      });
      document.querySelector("#device").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await run(() => post("/api/devices", Object.fromEntries(form.entries())));
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
    [PUSH_CAPABILITY_ID]: (request: Request, env: SandstormEnv) =>
      new PushNotificationTarget(request, env as Env),
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = sandstorm(request, env, durableCapabilities);
    const grants = api.powerboxGrants({
      grants: {
        apns: {
          title: "Apple Push Notifications",
          description: "Used to send Apple Push Notification service requests.",
          storageKey: APNS_TOKEN_KEY,
          outboundHttp: {
            baseUrl: "https://api.push.apple.com/",
            methods: ["POST"],
          },
          saveLabel: { defaultText: "APNs outbound HTTP" },
          save: { label: "APNs outbound HTTP" },
        },
        fcm: {
          title: "Firebase Cloud Messaging",
          description: "Used to send Firebase Cloud Messaging requests.",
          storageKey: FCM_TOKEN_KEY,
          outboundHttp: {
            baseUrl: "https://fcm.googleapis.com/",
            methods: ["POST"],
          },
          saveLabel: { defaultText: "FCM outbound HTTP" },
          save: { label: "FCM outbound HTTP" },
        },
      },
    });
    const url = new URL(request.url);

    try {
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const grantRoute = await grants.serve(request);
      if (grantRoute) return grantRoute;

      const rpcRoute = await api.serveRpc(() => new PushNotificationTarget(request, env));
      if (rpcRoute) return rpcRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/devices") return upsertDevice(request, env);
      if (request.method === "POST" && url.pathname === "/api/capability") {
        const { capability, token } = await ensureCapability(request, env);
        try {
          return Response.json({
            ok: true,
            capability: JSON.parse(JSON.stringify(capability)),
            token,
          });
        } finally {
          await capability.drop();
        }
      }

      return new Response(html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
