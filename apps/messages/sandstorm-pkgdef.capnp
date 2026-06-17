@0xa575668ebfef1a5d;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";
using MailAgent = import "../../packages/protocol/capnp/mail-agent.capnp";

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Mail Agent Messages"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening this messages grain")
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
    .MailAgent.messageSinkDescriptor,
    .MailAgent.messageInboxDescriptor
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
        esModulePath = "app/apps/messages/dist/worker.js"
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
  id = "e54fc506885cbcdb007b7dc03fb6f5d9",

  manifest = (
    appTitle = (defaultText = "Mail Agent Messages"),
    appVersion = 0,
    appMarketingVersion = (defaultText = "dev"),

    actions = [
      ( title = (defaultText = "New Messages Inbox"),
        nounPhrase = (defaultText = "inbox"),
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
    "app/apps/messages/dist/worker.js",
    "app/apps/messages/dist/worker.js.map"
  ]
);
