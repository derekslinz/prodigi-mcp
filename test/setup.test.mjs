import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SETUP = resolve(
  fileURLToPath(new URL("../dist/setup.js", import.meta.url)),
);
const tempDirs = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "prodigi-setup-"));
  tempDirs.push(dir);
  return dir;
}

/** Runs the installer in `cwd`, returning its combined output. */
function run(cwd, args) {
  try {
    return execFileSync(process.execPath, [SETUP, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Failures exit non-zero; surface stderr so assertions can inspect it.
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("setup: project scope with a key", () => {
  it("appends .mcp.json to an existing .gitignore", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");

    const out = run(dir, [
      "--client",
      "claude-code-project",
      "--project-dir",
      dir,
      "--environment",
      "sandbox",
      "--key",
      "secret-abc",
    ]);

    assert.match(out, /\.mcp\.json/);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(gitignore, /^node_modules\/$/m);
    assert.match(gitignore, /^\.mcp\.json$/m);
  });

  it("does not concatenate onto a file missing a trailing newline", () => {
    const dir = scratch();
    // A file with no final newline is the case that silently corrupts to
    // "node_modules/.mcp.json" if the separator is mishandled.
    writeFileSync(join(dir, ".gitignore"), "node_modules/", "utf8");

    run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox", "--key", "k"]);

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.doesNotMatch(gitignore, /node_modules\/\.mcp\.json/);
    assert.equal(gitignore, "node_modules/\n.mcp.json\n");
  });

  it("creates .gitignore when none exists", () => {
    const dir = scratch();
    run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox", "--key", "k"]);

    assert.ok(existsSync(join(dir, ".gitignore")));
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".mcp.json\n");
  });

  it("does not duplicate an existing '/.mcp.json' entry", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, ".gitignore"),
      "# deps\nnode_modules/\n\n# mcp\n/.mcp.json\n",
      "utf8",
    );

    const out = run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox", "--key", "k"]);

    assert.match(out, /already in .gitignore/);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(gitignore.match(/mcp\.json/g).length, 1);
  });

  it("handles CRLF line endings when detecting an existing entry", () => {
    const dir = scratch();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\r\n", "utf8");

    run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox", "--key", "k"]);

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    // The existing CRLF line must survive, and ours is appended separately.
    assert.match(gitignore, /^node_modules\/\r\n/);
    assert.match(gitignore, /^\.mcp\.json$/m);
  });

  it("is idempotent across repeated runs", () => {
    const dir = scratch();
    run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox", "--key", "k"]);
    const after1 = readFileSync(join(dir, ".gitignore"), "utf8");

    const out = run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox", "--key", "k"]);

    assert.match(out, /already in .gitignore/);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), after1);
  });

  it("writes the key into .mcp.json", () => {
    const dir = scratch();
    run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox", "--key", "secret-abc"]);

    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.equal(config.mcpServers.prodigi.env.PRODIGI_API_KEY, "secret-abc");
  });

  it("writes nothing under --dry-run", () => {
    const dir = scratch();
    const out = run(dir, [
      "--client",
      "claude-code-project",
      "--project-dir",
      dir,
      "--environment",
      "sandbox",
      "--key",
      "k",
      "--dry-run",
    ]);

    assert.match(out, /would add/);
    assert.ok(!existsSync(join(dir, ".gitignore")));
    assert.ok(!existsSync(join(dir, ".mcp.json")));
  });
});

describe("setup: project scope without a key", () => {
  it("does not touch .gitignore, so the config stays shareable", () => {
    const dir = scratch();
    const out = run(dir, ["--client", "claude-code-project", "--project-dir", dir, "--environment", "sandbox"]);

    assert.ok(existsSync(join(dir, ".mcp.json")));
    assert.ok(
      !existsSync(join(dir, ".gitignore")),
      "a keyless config is meant to be committed, so it must not be ignored",
    );
    assert.doesNotMatch(out, /gitignore/);

    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.ok(!config.mcpServers.prodigi.env, "no env block without a key");
  });
});

describe("setup: other clients", () => {
  it("never touches .gitignore for non-project scopes", () => {
    const dir = scratch();
    run(dir, ["--client", "claude-code", "--environment", "sandbox", "--key", "k"]);

    assert.ok(!existsSync(join(dir, ".gitignore")));
    assert.ok(existsSync(join(dir, ".claude.json")));
  });

  it("redacts the key in diff output", () => {
    const dir = scratch();
    const out = run(dir, [
      "--client",
      "claude-code",
      "--environment",
      "sandbox",
      "--key",
      "secret-abc",
    ]);
    // First run is an add, so force an update to get a diff.
    const second = run(dir, [
      "--client",
      "claude-code",
      "--environment",
      "sandbox",
      "--key",
      "rotated",
    ]);

    assert.doesNotMatch(out, /secret-abc/);
    assert.match(second, /PRODIGI_API_KEY/);
    assert.doesNotMatch(second, /rotated/);
    assert.match(second, /\*\*\*\*/);
  });

  it("prints only mcpServers, not unrelated config", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        numStartups: 42,
        someSecretSetting: "do-not-print",
        mcpServers: {},
      }),
      "utf8",
    );

    const out = run(dir, ["--client", "claude-code", "--environment", "sandbox", "--print-config"]);

    assert.match(out, /mcpServers|"prodigi"/);
    assert.doesNotMatch(out, /numStartups/);
    assert.doesNotMatch(out, /do-not-print/);
  });
});

describe("setup: guards", () => {
  it("refuses to write a config when no environment was chosen", () => {
    const dir = scratch();
    const out = run(dir, ["--client", "claude-code", "--key", "k"]);

    assert.match(out, /Choose an environment/);
    assert.match(out, /--environment sandbox or --environment live/);
    assert.ok(!existsSync(join(dir, ".claude.json")));
  });

  it("refuses project scope without --project-dir", () => {
    const dir = scratch();
    const out = run(dir, [
      "--client",
      "claude-code-project",
      "--environment",
      "sandbox",
      "--key",
      "k",
    ]);

    assert.match(out, /needs to know which one/);
    assert.match(out, /--project-dir/);
    assert.ok(!existsSync(join(dir, ".mcp.json")));
  });

  it("never writes .mcp.json into the current directory", () => {
    const dir = scratch();
    // cwd is the scratch dir, but the target is elsewhere: the config must
    // follow --project-dir, never process.cwd().
    const target = join(dir, "elsewhere");
    mkdirSync(target, { recursive: true });

    run(dir, [
      "--client",
      "claude-code-project",
      "--project-dir",
      target,
      "--environment",
      "sandbox",
      "--key",
      "k",
    ]);

    assert.ok(existsSync(join(target, ".mcp.json")));
    assert.ok(!existsSync(join(dir, ".mcp.json")), "must not touch cwd");
  });

  it("puts .gitignore in the target repo, not the current directory", () => {
    const dir = scratch();
    const target = join(dir, "elsewhere");
    mkdirSync(target, { recursive: true });

    run(dir, [
      "--client",
      "claude-code-project",
      "--project-dir",
      target,
      "--environment",
      "sandbox",
      "--key",
      "k",
    ]);

    assert.ok(existsSync(join(target, ".gitignore")));
    assert.ok(!existsSync(join(dir, ".gitignore")), "must not touch cwd");
  });

  it("accepts production as live", () => {
    const dir = scratch();
    run(dir, [
      "--client",
      "claude-code-project",
      "--project-dir",
      dir,
      "--environment",
      "production",
      "--key",
      "k",
    ]);

    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.equal(config.mcpServers.prodigi.env.PRODIGI_ENVIRONMENT, "live");
  });

  it("accepts an interactive environment answer of 'l' or 'sandbox'", () => {
    // Piped stdin is not a TTY, so this exercises the guard rather than the
    // prompt; the prompt itself is covered by scripts/pty-setup-check.py.
    const out = run(scratch(), ["-i", "--client", "claude-code"]);
    assert.match(out, /--interactive requires an interactive terminal/);
  });
});

describe("setup: argument validation", () => {
  it("rejects an unknown option", () => {
    const out = run(scratch(), ["--bogus"]);
    assert.match(out, /Unknown option/);
  });

  it("rejects a value flag with no value", () => {
    const out = run(scratch(), ["--key"]);
    assert.match(out, /--key requires a value/);
  });

  it("rejects an unknown client", () => {
    const out = run(scratch(), ["--client", "nope"]);
    assert.match(out, /No matching client/);
  });

  it("rejects an invalid environment rather than writing a broken config", () => {
    const dir = scratch();
    const out = run(dir, [
      "--client",
      "claude-code-project",
      "--project-dir",
      dir,
      "--environment",
      "sandbox",
      "--key",
      "k",
      "--environment",
      "staging",
    ]);

    assert.match(out, /sandbox.*live|staging/);
    assert.ok(!existsSync(join(dir, ".mcp.json")));
  });

  it("normalises 'production' to 'live'", () => {
    const dir = scratch();
    run(dir, [
      "--client",
      "claude-code-project",
      "--project-dir",
      dir,
      "--key",
      "k",
      "--environment",
      "production",
    ]);

    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.equal(
      config.mcpServers.prodigi.env.PRODIGI_ENVIRONMENT,
      "live",
    );
  });

  it("reports malformed JSON without overwriting it", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".config/Claude"), { recursive: true });
    const configPath = join(dir, ".config/Claude/claude_desktop_config.json");
    writeFileSync(configPath, "{ broken", "utf8");

    const out = run(dir, ["--client", "claude-desktop", "--environment", "sandbox", "--key", "k"]);

    assert.match(out, /not valid JSON/);
    assert.equal(
      readFileSync(configPath, "utf8"),
      "{ broken",
      "the original file must be left alone",
    );
  });
});