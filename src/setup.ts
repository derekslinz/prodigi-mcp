#!/usr/bin/env node
/**
 * Registers this MCP server with an MCP client.
 *
 *   node dist/setup.js                       # interactive
 *   node dist/setup.js --client claude-desktop --dry-run
 *   node dist/setup.js --key <api-key> --environment sandbox
 *
 * Design constraints:
 * - Idempotent. Re-running updates the existing entry rather than duplicating it.
 * - Non-destructive. Backs up before writing and preserves unrelated entries,
 *   key ordering, and formatting where feasible.
 * - Never writes a secret to a config file unless explicitly given one. Without
 *   --key it leaves the entry without credentials so the client inherits them
 *   from its own environment.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const SERVER_NAME = "prodigi";

/** An MCP server definition as it appears in a client config file. */
interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ClientTarget {
  id: string;
  label: string;
  path: string;
  shape: string;
}

type InstallAction = "add" | "update" | "unchanged";

interface InstallResult {
  action: InstallAction;
  path: string;
  previous?: McpServerEntry;
  next?: Record<string, unknown>;
  entry: McpServerEntry;
  backupPath?: string;
}

interface Options {
  dryRun: boolean;
  interactive: boolean;
  printConfig: boolean;
  redact: boolean;
  apiKey?: string;
  environment?: string;
  targets: string[];
  projectDir?: string;
  help: boolean;
}

/**
 * Where each client keeps its MCP server definitions, and the shape it expects.
 *
 * `scope: "user"` configs apply everywhere; `"project"` configs live in the
 * repo and are shared with collaborators, so they never carry an API key.
 */
/**
 * Resolves the directory a project-scoped config should be written to.
 *
 * Never defaults to `process.cwd()`: the setup command is frequently run from
 * inside this server's own repository, and silently dropping a `.mcp.json` in
 * there would pollute an unrelated project (or commit a secret into this one).
 * An explicit `--project-dir` is required instead.
 */
function resolveProjectDirError(): string {
  return (
    "--client claude-code-project writes .mcp.json into a repository, so it " +
    "needs to know which one. Pass --project-dir <path>, or omit --client to " +
    "register at user scope instead."
  );
}

function clientTargets(projectDir?: string) {
  const home = homedir();
  const os = platform();

  const desktopConfig =
    os === "win32"
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : os === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(home, ".config", "Claude", "claude_desktop_config.json");

  const targets = [
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      path: desktopConfig,
      shape: "mcpServers",
    },
    {
      id: "claude-code",
      label: "Claude Code (user scope)",
      path: join(home, ".claude.json"),
      shape: "mcpServers",
    },
  ];

  // Only offer project scope once a directory has been named explicitly.
  if (projectDir) {
    targets.push({
      id: "claude-code-project",
      label: `Claude Code (project: ${projectDir})`,
      path: join(projectDir, ".mcp.json"),
      shape: "mcpServers",
    });
  }

  return targets;
}

/** Preserves the JSON style of an existing file so diffs stay small. */
function detectStyle(text: string): string {
  if (/\n\s{2,}/.test(text)) return "pretty";
  return "compact";
}

/**
 * True when git already tracks `path`. Used only to warn: a `.gitignore` entry
 * is inert for a file that is already in the index.
 *
 * Runs git inside `cwd` so the answer reflects the target repository rather
 * than wherever the setup command happened to be invoked from.
 */
function isGitTracked(path: string, cwd: string): boolean {
  try {
    const result = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", "--", path],
      { cwd, stdio: "ignore" },
    );
    return result.status === 0;
  } catch {
    // git absent or not a repository; nothing useful to report.
    return false;
  }
}

/**
 * Adds a pattern to the project's `.gitignore`, creating the file if needed.
 *
 * A `.mcp.json` that carries an API key must never be committed. Rather than
 * refusing the combination, the installer makes the safe outcome the default:
 * write the config, then ensure it is ignored.
 */
function ensureGitignored(
  pattern: string,
  projectDir: string,
  { dryRun }: { dryRun: boolean },
): { action: "added" | "present" | "created"; path: string } {
  const path = join(projectDir, ".gitignore");
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, "utf8") : "";

  // Treat a leading slash and surrounding whitespace as equivalent so an
  // existing `/.mcp.json` is recognised as already covering `.mcp.json`.
  const normalise = (line: string): string =>
    line.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const target = normalise(pattern);

  if (
    text
      .split("\n")
      .map(normalise)
      .some((line) => line === target)
  ) {
    return { action: "present", path };
  }

  // Preserve whatever the file already ends with, so appending does not
  // concatenate onto an unterminated final line.
  const separator = text === "" ? "" : text.endsWith("\n") ? "" : "\n";
  const next = `${text}${separator}${pattern}\n`;

  if (dryRun) {
    return { action: exists ? "added" : "created", path };
  }

  if (exists) {
    backup(path);
  }
  writeFileSync(path, next, "utf8");
  return { action: exists ? "added" : "created", path };
}

function writeJson(path: string, value: unknown, style: string): void {
  const indent = style === "compact" ? 0 : 2;
  const json = JSON.stringify(value, null, indent);
  writeFileSync(path, indent === 0 ? json : `${json}\n`, "utf8");
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.bak-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}

/** Strips the key from an existing entry so we can report what changed. */
function redactEntry(entry: McpServerEntry): McpServerEntry {
  const clone = JSON.parse(JSON.stringify(entry));
  if (clone.env) {
    for (const key of Object.keys(clone.env)) {
      if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) clone.env[key] = "****";
    }
  }
  return clone;
}

/**
 * Redacts secrets across a whole config document, not just our own entry.
 *
 * `--print-config` prints the entire resulting file, which may contain API keys
 * belonging to other MCP servers the user has configured. Those must not be
 * echoed to the terminal or a log by default; `--no-redact` opts out.
 */
function redactDocument(document: unknown): unknown {
  if (!document || typeof document !== "object") return document;
  const clone = JSON.parse(JSON.stringify(document));
  const servers = clone.mcpServers;
  if (servers && typeof servers === "object") {
    for (const name of Object.keys(servers)) {
      servers[name] = redactEntry(servers[name]);
    }
  }
  if (clone.env && typeof clone.env === "object") {
    for (const key of Object.keys(clone.env)) {
      if (/KEY|SECRET|TOKEN|PASSWORD/i.test(key)) clone.env[key] = "****";
    }
  }
  return clone;
}

/**
 * Asks which environment to configure, defaulting the *offer* to sandbox but
 * requiring an explicit answer. Accepts the words people actually type.
 */
async function promptForEnvironment(): Promise<string> {
  const answer = (
    await prompt(
      "Environment - sandbox (no real orders, nothing charged) or live " +
        "(real orders, billed)? [s/l]: ",
    )
  ).toLowerCase();

  switch (answer) {
    case "s":
    case "sandbox":
      return "sandbox";
    case "l":
    case "live":
    case "p":
    case "production":
      return "live";
    default:
      throw new Error(
        `Unrecognised environment "${answer}". Answer s for sandbox or l for live.`,
      );
  }
}

/**
 * The server only accepts `sandbox` or `live`. Validate here so a typo produces
 * a clear message rather than a config that makes the server fail to start.
 * `production` is accepted as a common synonym for `live`.
 */
function normaliseEnvironment(value: string): "sandbox" | "live" {
  const normalised = value.trim().toLowerCase();
  if (normalised === "production") return "live";
  if (normalised === "sandbox" || normalised === "live") return normalised;
  throw new Error(
    `Environment must be "sandbox" or "live", received "${value}".`,
  );
}

function buildEntry({
  entrypoint,
  apiKey,
  environment,
}: {
  entrypoint: string;
  apiKey?: string;
  environment: string;
}): McpServerEntry {
  const entry: McpServerEntry = {
    command: process.execPath,
    args: [entrypoint],
  };
  if (apiKey) {
    entry.env = {
      PRODIGI_API_KEY: apiKey,
      PRODIGI_ENVIRONMENT: environment,
    };
  }
  return entry;
}

function install(
  target: ClientTarget,
  entry: McpServerEntry,
  { dryRun }: { dryRun: boolean },
): InstallResult {
  const { path, shape } = target;
  const exists = existsSync(path);

  let document: Record<string, unknown> = {};
  let style = "pretty";
  if (exists) {
    const text = readFileSync(path, "utf8");
    style = detectStyle(text);
    try {
      document = JSON.parse(text) as Record<string, unknown>;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${path} is not valid JSON (${detail}). Fix or remove it, then re-run.`,
      );
    }
  }

  if (document[shape] && typeof document[shape] !== "object") {
    throw new Error(`${path} has a "${shape}" key that is not an object; refusing to overwrite.`);
  }

  const servers: Record<string, McpServerEntry> = {
    ...((document[shape] as Record<string, McpServerEntry> | undefined) ?? {}),
  };
  const previous = servers[SERVER_NAME];
  const changed = JSON.stringify(previous) !== JSON.stringify(entry);

  if (!changed) {
    // Still return `next`: --print-config uses it to show the current state, and
    // without it an already-correct config would print as an empty object.
    return {
      action: "unchanged",
      path,
      previous,
      next: { ...document, [shape]: servers },
      entry,
    };
  }

  servers[SERVER_NAME] = entry;

  // Preserve the original key order: existing servers first, ours appended.
  const ordered: Record<string, McpServerEntry> = {};
  for (const key of Object.keys(
    (document[shape] as Record<string, McpServerEntry> | undefined) ?? {},
  )) {
    ordered[key] = servers[key]!;
  }
  ordered[SERVER_NAME] = servers[SERVER_NAME]!;

  const next: Record<string, unknown> = { ...document, [shape]: ordered };

  if (dryRun) {
    return {
      action: previous ? "update" : "add",
      path,
      previous,
      next,
      entry,
    };
  }

  const backupPath = backup(path);
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, next, style);
  return {
    action: previous ? "update" : "add",
    path,
    previous,
    next,
    entry,
    ...(backupPath ? { backupPath } : {}),
  };
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    interactive: false,
    printConfig: false,
    redact: true,
    targets: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Value-taking flags consume the next token; a missing value is a usage
    // error rather than something to silently treat as undefined.
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`${arg} requires a value.`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--dry-run":
      case "-n":
        options.dryRun = true;
        break;
      case "--interactive":
      case "-i":
        options.interactive = true;
        break;
      case "--print-config":
      case "--print":
      case "-p":
        options.printConfig = true;
        break;
      case "--no-redact":
        options.redact = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--key":
        options.apiKey = value();
        break;
      case "--environment":
      case "--env":
        options.environment = value();
        break;
      case "--client":
        options.targets.push(value());
        break;
      case "--project-dir":
        options.projectDir = value();
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    }
  }
  return options;
}

const USAGE = `
Register the Prodigi MCP server with an MCP client.

  node dist/setup.js [options]

Options
  -i, --interactive          Ask before each change
  -n, --dry-run             Report what would change without writing
  -p, --print-config        Print the resulting JSON config instead of writing
      --no-redact           With --print-config, show secrets unmasked
      --client <id>         Target a specific client (repeatable)
      --project-dir <path>  Repository for --client claude-code-project
      --key <api-key>       Prodigi API key (omit to rely on the client's env)
      --environment <env>   sandbox or live (required, or asked with -i)
  -h, --help                Show this help

Clients
  claude-desktop            Claude Desktop
  claude-code               Claude Code, user scope (default)
  claude-code-project       Claude Code, project scope (needs --project-dir)

Notes
  --environment is never defaulted. Pointing a live key at the wrong
  environment is the expensive mistake, so the choice is always explicit.

  --client claude-code-project requires --project-dir. The current directory
  is not assumed, so running this from a repository never writes into it by
  accident.

  With --project-dir and --key, .mcp.json is added to that repository's
  .gitignore automatically. Omit --key to share the config instead.

Examples
  node dist/setup.js --environment sandbox
  node dist/setup.js --interactive
  node dist/setup.js --client claude-desktop --environment live --key abc-123
  node dist/setup.js --client claude-code-project --project-dir ../my-app \
    --environment sandbox --key abc-123
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const entrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
  if (!existsSync(entrypoint)) {
    throw new Error(`Built server not found at ${entrypoint}. Run "npm run build" first.`);
  }

  const all = clientTargets(options.projectDir);
  const wantsProject = options.targets.includes("claude-code-project");
  if (wantsProject && !options.projectDir) {
    throw new Error(
      resolveProjectDirError(),
    );
  }
  const selected =
    options.targets.length > 0
      ? all.filter((t) => options.targets.includes(t.id))
      : // Default: Claude Code user scope. It is the safest target and the one
        // most likely to already exist on a developer machine.
        all.filter((t) => t.id === "claude-code");

  if (selected.length === 0) {
    throw new Error(
      `No matching client. Available: ${all.map((t) => t.id).join(", ")}`,
    );
  }

  const projectDir = options.projectDir ? resolve(options.projectDir) : undefined;

  let apiKey = options.apiKey;
  let environment = options.environment;

  if (!apiKey && process.env.PRODIGI_API_KEY) {
    apiKey = process.env.PRODIGI_API_KEY;
  }

  const interactive = options.interactive;

  if (interactive && !process.stdin.isTTY) {
    throw new Error("--interactive requires an interactive terminal.");
  }

  // Choosing the wrong environment is the costly mistake here: a live key
  // pointed at sandbox simply fails, but a sandbox assumption against a live
  // key means real orders. So the choice is always made deliberately - never
  // inherited from a default.
  if (!environment && interactive) {
    environment = await promptForEnvironment();
  }
  if (!environment) {
    throw new Error(
      "Choose an environment before writing a config: pass --environment " +
        "sandbox or --environment live, or run with --interactive to be asked.\n" +
        "This is not defaulted on purpose - pointing a live key at the wrong " +
        "environment is the expensive mistake to avoid.",
    );
  }
  environment = normaliseEnvironment(environment);

  if (interactive) {
    const key = await prompt(
      "Prodigi API key (blank to use the client's environment): ",
    );
    if (key) apiKey = key;
  }

  console.log(`Prodigi MCP setup\n  entrypoint: ${entrypoint}`);
  console.log(
    `  credentials: ${
      apiKey
        ? `embedding PRODIGI_API_KEY in the config (${
            environment === "live" ? "LIVE" : "sandbox"
          })`
        : "none - the server will read PRODIGI_API_KEY from the client's environment"
    }\n`,
  );

  // --print-config is a pure query: it reports the exact JSON that would result
  // and writes nothing, so it short-circuits the install loop entirely.
  if (options.printConfig) {
    for (const target of selected) {
      const entry = buildEntry({ entrypoint, apiKey, environment });
      const result = install(target, entry, { dryRun: true });
      const printable = options.redact
        ? redactDocument(result.next)
        : result.next;

      // Print only the `mcpServers` map. Claude Code's user-scope file also
      // holds session state, feature flags and usage counters; echoing all of
      // it would bury the part that matters and expose unrelated settings.
      const servers = (printable as Record<string, unknown> | undefined)?.mcpServers;
      const payload = servers ?? {};

      if (selected.length > 1) {
        console.log(`# ${target.label} -> ${target.path}`);
      }
      console.log(JSON.stringify(payload, null, 2));
      if (selected.length > 1) {
        console.log();
      }
    }
    return;
  }

  for (const target of selected) {
    const exists = existsSync(target.path);
    const entry = buildEntry({ entrypoint, apiKey, environment });

    if (options.interactive && exists) {
      const answer = await prompt(
        `Update ${target.label} config at ${target.path}? [y/N] `,
      );
      if (answer.toLowerCase() !== "y") {
        console.log(`  skipped ${target.label}`);
        continue;
      }
    }

    const result = install(target, entry, { dryRun: options.dryRun });

    switch (result.action) {
      case "add":
        console.log(
          `  ${options.dryRun ? "would add" : "added"}    ${target.label} -> ${result.path}`,
        );
        break;
      case "update":
        console.log(
          `  ${options.dryRun ? "would update" : "updated"} ${target.label} -> ${result.path}`,
        );
        if (result.previous) {
          console.log(`           was: ${JSON.stringify(redactEntry(result.previous))}`);
        }
        console.log(`           now: ${JSON.stringify(redactEntry(result.entry ?? entry))}`);
        break;
      case "unchanged":
        console.log(`  unchanged ${target.label} (already correct)`);
        break;
      default:
        console.log(`  skipped  ${target.label}`);
    }
    if (result.backupPath) {
      console.log(`           backup: ${result.backupPath}`);
    }

    // A project-scoped config carrying a key must not be committable. Rather
    // than blocking the combination, make the safe outcome automatic.
    if (target.id === "claude-code-project" && apiKey && projectDir) {
      const ignored = ensureGitignored(".mcp.json", projectDir, {
        dryRun: options.dryRun,
      });
      if (ignored.action === "present") {
        console.log("           .mcp.json already in .gitignore");
      } else {
        console.log(
          `           ${options.dryRun ? "would add" : "added"} .mcp.json to .gitignore (it holds your API key)`,
        );
      }

      // A .gitignore entry has no effect once the file is tracked, so if it is
      // already staged say so rather than implying the key is now safe.
      if (
        !options.dryRun &&
        isGitTracked(join(projectDir, ".mcp.json"), projectDir)
      ) {
        console.log(
          "           WARNING: .mcp.json is already tracked by git. Run " +
            "`git rm --cached .mcp.json` to stop tracking it, and rotate the " +
            "key if it was ever committed.",
        );
      }
    }
  }

  console.log("\nDone. Restart the client to pick up the change.");
}

main().catch((err) => {
  console.error(`setup failed: ${err.message}`);
  process.exit(1);
});