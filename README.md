# Mail Agent

This repo is an npm workspace for a Sandstorm isolate-grain mail agent. The
workspace contains five independent isolate apps:

- `apps/llm`: owns the OpenAI outbound HTTP grant and exports
  `conversational-llm-v1`.
- `apps/mail-classifier`: owns the mail feed subscription and exports
  `mail-event-port-v1`.
- `apps/dummy-email-producer`: sends fixed sample mail events to a connected
  classifier receiver.
- `apps/messages`: stores generated inbox messages and exports
  `message-sink-v1` and `message-inbox-v1`.
- `apps/mobile-notifications`: owns APNs/FCM outbound HTTP grants and exports
  `push-notification-v1`.

The shared TypeScript protocol shapes live in `packages/protocol`.

## Build

```sh
npm install
npm run check
npm run build
```

Each app builds to `dist/worker.js`, which is referenced by that app's
`sandstorm-pkgdef.capnp`.

## Run an isolate grain

```sh
npm run dev:llm
npm run dev:messages
npm run dev:dummy-email-producer
npm run dev:mobile-notifications
npm run dev:mail-classifier
```

The scripts run `spk dev -p <app>/sandstorm-pkgdef.capnp:pkgdef` directly and
do not require a Sandstorm app VM.

## Outbound HTTP

OpenAI, APNs, and FCM authority is requested through Sandstorm's browser-first
outbound HTTP Powerbox helper:

```js
import { requestOutboundHttpPowerbox } from "./rpc-client.js";

const requested = await requestOutboundHttpPowerbox({
  baseUrl: "https://api.openai.com/",
  methods: ["GET", "POST"],
});

await fetch("/api/openai/claim", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(requested),
});
```

The worker route claims and stores the returned request token with
`api.powerbox().claimAndStoreRequest()`. The provider-call code is
intentionally localized to the LLM and mobile notification workers.
