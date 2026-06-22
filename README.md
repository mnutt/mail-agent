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

Start every app's `spk dev` process at once:

```sh
npm run dev:all
```

Or start a single app:

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

OpenAI, APNs, and FCM authority is requested through Sandstorm's generated
Powerbox grant UI:

```html
<script type="module" src="/__sandstorm/powerbox-grants/client.js"></script>
<sandstorm-powerbox-grant grant="openai"></sandstorm-powerbox-grant>
```

The worker defines grants with `api.powerboxGrants(...)`, serves the generated
routes with `grants.serve(request)`, and uses the saved token from isolate
storage when sending provider calls.
