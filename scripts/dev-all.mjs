import { spawn } from "node:child_process";

const scripts = [
  "dev:llm",
  "dev:mail-classifier",
  "dev:messages",
  "dev:dummy-email-producer",
  "dev:mobile-notifications",
];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const detached = process.platform !== "win32";
const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function stopChild(child, signal) {
  if (child.killed) {
    return;
  }

  try {
    if (detached && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") {
      console.error("Failed to stop dev process:", error);
    }
  }
}

function stopChildren(signal = "SIGTERM") {
  shuttingDown = true;

  for (const child of children.values()) {
    stopChild(child, signal);
  }
}

function finishIfDone() {
  if (children.size === 0) {
    process.exit(exitCode);
  }
}

for (const script of scripts) {
  const child = spawn(npm, ["run", script], {
    detached,
    stdio: "inherit",
  });

  children.set(script, child);

  child.on("error", (error) => {
    console.error(`Failed to start ${script}:`, error);
    exitCode = 1;
    children.delete(script);
    stopChildren();
    finishIfDone();
  });

  child.on("exit", (code, signal) => {
    children.delete(script);

    if (!shuttingDown) {
      if (code !== 0) {
        exitCode = code ?? 1;
      }

      console.error(`${script} exited${signal ? ` from ${signal}` : ""}; stopping remaining dev servers.`);
      stopChildren();
    }

    finishIfDone();
  });
}

process.on("SIGINT", () => stopChildren("SIGINT"));
process.on("SIGTERM", () => stopChildren("SIGTERM"));
