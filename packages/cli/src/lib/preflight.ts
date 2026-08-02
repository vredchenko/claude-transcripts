/**
 * Preflight: decide whether an install can work **before** anything is written.
 *
 * The point is that a doomed install fails in seconds having changed nothing, and
 * reports *every* problem at once with the fix for each — not the first one, then
 * another after you fix it. The failures here are the ones that actually happen on a
 * first run, and several look alike while needing completely different fixes (a daemon
 * that isn't running vs. a socket you can't talk to).
 */
import { $ } from "bun";

export type CheckStatus = "ok" | "fail" | "warn";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What the user should do about it. */
  fix?: string;
}

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin"]);

function platformCheck(): Check {
  const p = process.platform;
  return SUPPORTED_PLATFORMS.has(p)
    ? { name: "platform", status: "ok", detail: `${p}/${process.arch}` }
    : {
        name: "platform",
        status: "fail",
        detail: `${p} is not supported`,
        fix: "Linux and macOS only. On Windows, install inside WSL2.",
      };
}

/**
 * Docker: present, daemon reachable, and reachable *by this user*.
 *
 * `docker info` failing is ambiguous, so the message is chosen from the error text:
 * a missing binary, a daemon that isn't running, and a socket the user lacks
 * permission for are three different problems with three different fixes — and the
 * last is the most common first-run failure on Linux.
 */
async function dockerCheck(): Promise<Check> {
  try {
    await $`docker --version`.quiet();
  } catch {
    return {
      name: "docker",
      status: "fail",
      detail: "not found on PATH",
      fix: "Install Docker: https://docs.docker.com/engine/install/ (or Docker Desktop on macOS).",
    };
  }
  try {
    await $`docker info`.quiet();
    return { name: "docker", status: "ok", detail: "daemon reachable" };
  } catch (err) {
    const text = String((err as { stderr?: Buffer }).stderr ?? err).toLowerCase();
    if (text.includes("permission denied")) {
      return {
        name: "docker",
        status: "fail",
        detail: "permission denied talking to the Docker socket",
        fix: "Add yourself to the `docker` group (`sudo usermod -aG docker $USER`), then log out and back in.",
      };
    }
    return {
      name: "docker",
      status: "fail",
      detail: "daemon not reachable",
      fix:
        process.platform === "darwin"
          ? "Start Docker Desktop and wait for it to report running."
          : "Start the daemon: `sudo systemctl start docker`.",
    };
  }
}

/** Compose v2 (`docker compose`). v1's `docker-compose` is not supported. */
async function composeCheck(): Promise<Check> {
  try {
    const out = await $`docker compose version`.quiet().text();
    return { name: "docker compose", status: "ok", detail: out.trim().split("\n")[0] ?? "v2" };
  } catch {
    return {
      name: "docker compose",
      status: "fail",
      detail: "the Compose v2 plugin is not available",
      fix: "Install the Docker Compose plugin. Standalone `docker-compose` (v1) is not supported.",
    };
  }
}

/** Is a TCP port free to bind on loopback? */
export async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Ports the stack needs. Occupied ports are a warning: install can shift the block. */
async function portsCheck(ports: number[]): Promise<Check> {
  const taken: number[] = [];
  for (const p of ports) if (!(await isPortFree(p))) taken.push(p);
  if (!taken.length) {
    return { name: "ports", status: "ok", detail: `${ports.length} free from ${ports[0]}` };
  }
  return {
    name: "ports",
    status: "warn",
    detail: `already in use: ${taken.join(", ")}`,
    fix: "Re-run with `--port-base <n>` to move the whole block, or stop whatever holds them.",
  };
}

/**
 * Claude Code's config directory. Absent is only a warning — registering the hook
 * still works, and applies as soon as Claude Code appears.
 */
async function claudeCheck(settingsPath: string): Promise<Check> {
  const dir = settingsPath.replace(/\/[^/]+$/, "");
  const exists = await Bun.file(settingsPath)
    .exists()
    .catch(() => false);
  if (exists) return { name: "claude code", status: "ok", detail: `settings at ${settingsPath}` };
  return {
    name: "claude code",
    status: "warn",
    detail: `no settings file at ${settingsPath}`,
    fix: `The hook will be registered anyway and applies once Claude Code writes ${dir}.`,
  };
}

export interface PreflightOptions {
  ports: number[];
  claudeSettings: string;
  /** Skip Docker checks (for `--no-stack` style runs). */
  skipDocker?: boolean;
}

export async function preflight(opts: PreflightOptions): Promise<Check[]> {
  const checks: Check[] = [platformCheck()];
  if (!opts.skipDocker) {
    const docker = await dockerCheck();
    checks.push(docker);
    // Only ask about Compose once the daemon answers — otherwise it fails for the
    // same reason and reports a second, misleading problem.
    if (docker.status === "ok") checks.push(await composeCheck());
  }
  checks.push(await portsCheck(opts.ports));
  checks.push(await claudeCheck(opts.claudeSettings));
  return checks;
}

export function renderChecks(checks: Check[]): string {
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  return checks
    .map((c) => {
      const head = `  ${icon[c.status]} ${c.name.padEnd(16)} ${c.detail}`;
      return c.status === "ok" || !c.fix ? head : `${head}\n      → ${c.fix}`;
    })
    .join("\n");
}

export const hasFailures = (checks: Check[]): boolean => checks.some((c) => c.status === "fail");
