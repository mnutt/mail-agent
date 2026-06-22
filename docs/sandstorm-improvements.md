# Sandstorm Improvements

Notes for Sandstorm platform/helper improvements encountered while building the
mail-agent isolate apps.

## Worker-side Powerbox request helper

Status: resolved by browser-first API/docs

The worker-side helper path for opening/requesting Powerbox was not usable from
the isolate app. The practical app workaround is to start Powerbox from the
browser with `postMessage`, then send the returned token or capability handle
back to the worker to claim/save it.

Resolution:

- The public worker API no longer exposes direct `requestOutboundHttp()` /
  `requestApiSession()` style helpers that imply the worker can open the
  Powerbox picker itself.
- The documented isolate author model is browser-first: browser code uses the
  `/rpc-client.js` `postMessage` helpers, then passes the returned token or
  claimed handle to the worker for `api.powerbox().claim()`, `cap.save()`, and
  app-owned token storage.
- This avoids exposing `SessionContext.request()` as new platform surface until
  Sandstorm has a clear story for worker-initiated, user-mediated UI.

## Cross-grain RPC capability arguments

Status: resolved by early rejection and documented saved-token pattern

Passing a live `Capability` as an argument to another grain's app-defined RPC
method appeared to serialize only the local capability ID. The receiving
grain then hydrates that ID against its own supervisor, and subsequent operations
such as `save()` fail with `unknown claimed capability`.

Repro shape:

1. Classifier restores a saved `MailFeed`.
2. Classifier creates/restores its persistent `MailEventPort`.
3. Classifier calls `mailFeed.addReceiver(receiver, subscription)`.
4. Dummy feed receives `receiver` and calls `receiver.save(...)`.
5. Dummy feed fails because the receiver handle ID is not known in the dummy
   grain's claimed-capability registry.

Resolution:

- Direct live `Capability` and raw `RpcTarget` callback arguments are
  now rejected at serialization time for remote app-defined RPC calls, before
  a useless local handle ID is sent to the receiver.
- Local object-capability calls still support live callback/capability
  arguments inside the same isolate supervisor.
- The isolate docs now state the cross-grain pattern: export a durable object
  capability, pass the saved token string, and have the receiver restore it
  before calling back.

Current app workaround:

- Pass a saved receiver token through the subscription request and have the
  provider restore that token when it needs to call back. This is now the
  documented supported pattern.

## Custom Powerbox descriptors in isolate apps

Status: implemented in platform, but easy to misuse

Custom app-to-app protocols need real packed Sandstorm `PowerboxDescriptor`
strings, not just JavaScript or TypeScript interface names.

Potential improvement:

- Keep docs explicit that `descriptor` / `powerboxDescriptor` values must be
  packed Sandstorm descriptors.
- Add helper utilities or examples for deriving and validating packed
  descriptors from app-local `.capnp` definitions.

## `spk dev` JSON encoding of descriptor values

Status: fixed in Sandstorm working tree

Descriptor tags with `value :AnyPointer` caused `spk dev` package-definition
JSON encoding to fail with `don't know how to JSON-encode AnyPointer`.

Resolution:

- `run-bundle`'s dev-package manifest JSON encoder now handles `AnyPointer`
  descriptor tag values by encoding them as flat Cap'n Proto bytes in Mongo
  `BinData(...)`, matching the shell's expected descriptor-tag representation.
- `make isolate-supervisor-integration-test` passed after the fix, and the
  ekam build log showed `run-bundle` compiling/linking/installing successfully.
