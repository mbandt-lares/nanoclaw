/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * Detect whether the Docker daemon can directly access host paths via bind mounts.
 * In LXC containers with a host-forwarded Docker socket, the daemon runs in a
 * different UID namespace and cannot see files created by the LXC guest.
 * Returns true if bind mounts work normally, false if staging is needed.
 */
let _bindMountsWork: boolean | undefined;
export function canUseBindMounts(): boolean {
  if (_bindMountsWork !== undefined) return _bindMountsWork;

  const testDir = path.join(process.cwd(), 'data', '.bind-test');
  const testFile = path.join(testDir, 'probe.txt');
  try {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testFile, 'bind-mount-probe');

    const result = spawnSync(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '--rm',
        '-v',
        `${testDir}:/probe:ro`,
        'alpine',
        'cat',
        '/probe/probe.txt',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
    );

    _bindMountsWork = result.stdout?.toString().trim() === 'bind-mount-probe';
  } catch {
    _bindMountsWork = false;
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  if (!_bindMountsWork) {
    logger.info(
      'Bind mounts not available (LXC/rootless Docker); using volume staging',
    );
  }
  return _bindMountsWork;
}

/**
 * Stage a host directory into a Docker volume so that the Docker daemon can
 * access its contents. Used when bind mounts don't work (LXC + host Docker).
 *
 * Files are piped via tar through a helper container into the volume.
 */
export function stageToVolume(
  hostDir: string,
  volumeName: string,
  excludePatterns?: string[],
): void {
  // Ensure volume exists
  spawnSync(CONTAINER_RUNTIME_BIN, ['volume', 'create', volumeName], {
    stdio: 'pipe',
  });

  // Tar the host directory and pipe into the volume via a helper container.
  // chown to 1000:1000 (node user) so the agent container can write to the volume.
  if (fs.existsSync(hostDir) && fs.readdirSync(hostDir).length > 0) {
    const tarArgs = ['cf', '-', '-C', hostDir];
    if (excludePatterns) {
      for (const pattern of excludePatterns) {
        tarArgs.push('--exclude', pattern);
      }
    }
    tarArgs.push('.');
    const tar = spawnSync('tar', tarArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 100 * 1024 * 1024,
    });

    if (tar.stdout && tar.stdout.length > 0) {
      const result = spawnSync(
        CONTAINER_RUNTIME_BIN,
        [
          'run',
          '--rm',
          '-i',
          '-v',
          `${volumeName}:/target`,
          'alpine',
          'sh',
          '-c',
          'cd /target && tar xf - && chown -R 1000:1000 /target',
        ],
        {
          input: tar.stdout,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000,
        },
      );

      if (result.status !== 0) {
        logger.warn(
          { volumeName, hostDir, stderr: result.stderr?.toString() },
          'Failed to stage files to Docker volume',
        );
      }
    }
  } else {
    // Empty directory — just ensure the volume root is writable by node user
    spawnSync(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '--rm',
        '-v',
        `${volumeName}:/target`,
        'alpine',
        'chown',
        '1000:1000',
        '/target',
      ],
      { stdio: 'pipe', timeout: 15000 },
    );
  }
}

/**
 * Retrieve files from a Docker volume back to a host directory.
 * Used after container execution to sync writable state back.
 */
export function retrieveFromVolume(volumeName: string, hostDir: string): void {
  fs.mkdirSync(hostDir, { recursive: true });

  const result = spawnSync(
    CONTAINER_RUNTIME_BIN,
    [
      'run',
      '--rm',
      '-v',
      `${volumeName}:/source:ro`,
      'alpine',
      'tar',
      'cf',
      '-',
      '-C',
      '/source',
      '.',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 100 * 1024 * 1024,
      timeout: 30000,
    },
  );

  if (result.status === 0 && result.stdout && result.stdout.length > 0) {
    const untar = spawnSync('tar', ['xf', '-', '-C', hostDir], {
      input: result.stdout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (untar.status !== 0) {
      logger.warn(
        { volumeName, hostDir, stderr: untar.stderr?.toString() },
        'Failed to retrieve files from Docker volume',
      );
    }
  }
}

/**
 * Remove a Docker volume.
 */
export function removeVolume(volumeName: string): void {
  try {
    spawnSync(CONTAINER_RUNTIME_BIN, ['volume', 'rm', '-f', volumeName], {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Write a file into a running Docker container via `docker exec`.
 * Used for IPC when bind mounts don't work (LXC + host Docker).
 * (`docker cp` fails in rootless Docker on LXC due to overlay remount.)
 */
export function copyToContainer(
  containerName: string,
  hostPath: string,
  containerPath: string,
): boolean {
  try {
    const content = fs.readFileSync(hostPath);
    const result = spawnSync(
      CONTAINER_RUNTIME_BIN,
      ['exec', '-i', containerName, 'sh', '-c', `cat > '${containerPath}'`],
      { input: content, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
