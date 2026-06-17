@0xaeccb284127d799c;

using Grain = import "/sandstorm/grain.capnp";
using Spk = import "/sandstorm/package.capnp";

const viewInfo :Grain.UiView.ViewInfo = (
  appTitle = (defaultText = "Mail Classifier"),

  permissions = [
    ( name = "view",
      title = (defaultText = "view"),
      description = (defaultText = "allows opening this mail classifier grain")
    )
  ],

  roles = [
    ( title = (defaultText = "viewer"),
      permissions = [true],
      verbPhrase = (defaultText = "can view"),
      default = true
    )
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
        esModulePath = "app/apps/mail-classifier/dist/worker.js"
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
  id = "f64328a72a9c0a2ab21c727e81e92df5",

  manifest = (
    appTitle = (defaultText = "Mail Classifier"),
    appVersion = 0,
    appMarketingVersion = (defaultText = "dev"),

    actions = [
      ( title = (defaultText = "New Mail Classifier"),
        nounPhrase = (defaultText = "classifier"),
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
    "app/apps/mail-classifier/dist/worker.js",
    "app/apps/mail-classifier/dist/worker.js.map"
  ]
);
