@0xbf59f256ad3559f2;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";
using MailAgent = import "../../packages/protocol/capnp/mail-agent.capnp";

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Mobile Notifications"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening this mobile notifications grain")
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
    .MailAgent.pushNotificationDescriptor
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
        esModulePath = "app/apps/mobile-notifications/dist/worker.js"
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
  id = "dba5129c7c47fd07188bb577972ea550",

  manifest = (
    appTitle = (defaultText = "Mobile Notifications"),
    appVersion = 0,
    appMarketingVersion = (defaultText = "dev"),

    actions = [
      ( title = (defaultText = "New Mobile Notifications"),
        nounPhrase = (defaultText = "notification sender"),
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
    "app/apps/mobile-notifications/dist/worker.js",
    "app/apps/mobile-notifications/dist/worker.js.map"
  ]
);
