@0x9dc0a573cb278f96;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";
using MailAgent = import "../../packages/protocol/capnp/mail-agent.capnp";

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Mail Agent LLM"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening this LLM grain")
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
    .MailAgent.conversationalLlmDescriptor
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
        esModulePath = "app/apps/llm/dist/worker.js"
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
  id = "d2a043712625865d271f905bacf7aae6",

  manifest = (
    appTitle = (defaultText = "Mail Agent LLM"),
    appVersion = 0,
    appMarketingVersion = (defaultText = "dev"),

    actions = [
      ( title = (defaultText = "New LLM"),
        nounPhrase = (defaultText = "LLM instance"),
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
    "app/apps/llm/dist/worker.js",
    "app/apps/llm/dist/worker.js.map"
  ]
);
