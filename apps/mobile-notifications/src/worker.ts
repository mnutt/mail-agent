/// <reference path="../../../types/sandstorm-isolate.d.ts" />

import { RpcTarget, sandstorm, validate } from "sandstorm:api";
import type { ClaimedCapability, SandstormEnv } from "sandstorm:api";
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

async function recordAttempts(request: Request, env: Env, attempts: DeliveryAttempt[]): Promise<void> {
  const store = sandstorm(request, env).storage();
  const current = (await store.getJson<DeliveryAttempt[]>(ATTEMPTS_KEY)) || [];
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

async function ensureCapability(request: Request, env: Env): Promise<ClaimedCapability> {
  const result = await sandstorm(request, env).persistentCapability(
    new PushNotificationTarget(request, env),
    {
      id: PUSH_CAPABILITY_ID,
      storageKey: PUSH_CAPABILITY_TOKEN_KEY,
      label: "Mobile push notification sender",
    },
  );
  return result.capability;
}

async function claimProvider(request: Request, env: Env, storageKey: string, label: string): Promise<Response> {
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
  return {
    capabilityId: PUSH_CAPABILITY_ID,
    devices: await readDevices(request, env),
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
      main { max-width: 58rem; }
      button { border: 1px solid #6f4e00; border-radius: 4px; background: #6f4e00; color: white; cursor: pointer; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.45rem 0.7rem; }
      input, select { border: 1px solid #a8b3c1; border-radius: 4px; font: inherit; margin: 0 0.4rem 0.6rem 0; padding: 0.4rem; }
      pre { background: #f7f8fa; border: 1px solid #cfd7e2; border-radius: 6px; overflow: auto; padding: 1rem; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>Mobile Notifications</h1>
      <button id="apns" type="button">Connect APNs</button>
      <button id="fcm" type="button">Connect FCM</button>
      <button id="capability" type="button">Create Push Capability</button>
      <button id="test" type="button">Test Push</button>
      <form id="device">
        <select name="platform"><option value="apns">APNs</option><option value="fcm">FCM</option></select>
        <input name="token" placeholder="device token">
        <input name="label" placeholder="label">
        <button type="submit">Add Device</button>
      </form>
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
      async function connect(path, options) {
        const requested = await requestOutboundHttpPowerbox(options);
        return await post(path, requested);
      }
      document.querySelector("#apns").addEventListener("click", () => run(() => connect("/api/apns/claim", {
        baseUrl: "https://api.push.apple.com/",
        methods: ["POST"],
        saveLabel: { defaultText: "APNs outbound HTTP" },
      })));
      document.querySelector("#fcm").addEventListener("click", () => run(() => connect("/api/fcm/claim", {
        baseUrl: "https://fcm.googleapis.com/",
        methods: ["POST"],
        saveLabel: { defaultText: "FCM outbound HTTP" },
      })));
      document.querySelector("#capability").addEventListener("click", async () => run(() => post("/api/capability")));
      document.querySelector("#test").addEventListener("click", async () => {
        await run(async () => {
          using rpc = newSandstormRpcSession();
          return await rpc.sendPushNotification({ id: crypto.randomUUID(), title: "Test", body: "Delivery check", urgency: "normal" });
        });
      });
      document.querySelector("#device").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await run(() => post("/api/devices", Object.fromEntries(form.entries())));
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
      const systemRoute = await api.serveSystemRoutes();
      if (systemRoute) return systemRoute;

      const rpcRoute = await api.serveRpc(() => new PushNotificationTarget(request, env));
      if (rpcRoute) return rpcRoute;

      if (url.pathname === "/api/state") return Response.json(await state(request, env));
      if (request.method === "POST" && url.pathname === "/api/apns/claim") {
        return claimProvider(request, env, APNS_TOKEN_KEY, "APNs outbound HTTP");
      }
      if (request.method === "POST" && url.pathname === "/api/fcm/claim") {
        return claimProvider(request, env, FCM_TOKEN_KEY, "FCM outbound HTTP");
      }
      if (request.method === "POST" && url.pathname === "/api/devices") return upsertDevice(request, env);
      if (request.method === "POST" && url.pathname === "/api/capability") {
        const capability = await ensureCapability(request, env);
        const saved = await capability.save({ label: "Mobile push notification sender" });
        return Response.json({
          ok: true,
          capability: JSON.parse(JSON.stringify(capability)),
          saved: JSON.parse(JSON.stringify(saved)),
        });
      }

      return new Response(html(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      return jsonError(error);
    }
  },
};
