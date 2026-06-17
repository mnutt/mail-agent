@0x8722c1c35b5d68c2;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";
using MailAgent = import "../../packages/protocol/capnp/mail-agent.capnp";

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Dummy Email Producer"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening this dummy email producer")
    )
  ],

  roles = [
    ( title = (defaultText = "viewer"),
      permissions = [true],
      verbPhrase = (defaultText = "can view"),
      default = true
    )
  ],

  matchRequests = [
    .MailAgent.mailFeedDescriptor
  ]
);

const command :Spk.Manifest.Command = (
  argv = [
    "workerd",
    "serve",
    "${SANDSTORM_ISOLATE_WORKERD_CONFIG}",
    "sandstormConfig"
  ],

  isolate = (
    mainModule = "worker.js",
    compatibilityDate = "2025-01-01",
    compatibilityFlags = [],

    modules = [
      (
        name = "worker.js",
        esModulePath = "app/apps/dummy-email-producer/dist/worker.js"
      )
    ],

    bindings = [
      ( name = "SANDSTORM_API", sandstormApi = void ),
      ( name = "POWERBOX", powerbox = void ),
      ( name = "STORAGE", storage = void )
    ],

    bridgeConfig = (
      viewInfo = .viewInfo
    )
  )
);

const pkgdef :Spk.PackageDefinition = (
  id = "84e3c745ebef2c0e34ceccd405b42c91",

  manifest = (
    appTitle = (defaultText = "Dummy Email Producer"),
    appVersion = 0,
    appMarketingVersion = (defaultText = "dev"),

    actions = [
      ( title = (defaultText = "New Dummy Email Producer"),
        nounPhrase = (defaultText = "email producer"),
        command = .command
      )
    ],

    continueCommand = .command
  ),

  sourceMap = (
    searchPath = [
      ( packagePath = "app", sourcePath = "../.." )
    ]
  ),

  alwaysInclude = [
    "sandstorm-manifest",
    "app/apps/dummy-email-producer/dist/worker.js",
    "app/apps/dummy-email-producer/dist/worker.js.map"
  ]
);
