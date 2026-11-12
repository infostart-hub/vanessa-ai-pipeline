#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function isFile(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDir(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readSettings(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.PLUGIN_DATA) {
    candidates.push(path.join(process.env.PLUGIN_DATA, 'settings.json'));
  }
  const home = os.homedir();
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, '1c-ai-pipeline', 'settings.json'));
  } else if (home) {
    candidates.push(path.join(home, '.config', '1c-ai-pipeline', 'settings.json'));
  }
  for (const file of candidates) {
    if (!isFile(file)) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { source: file, data: parsed };
      }
    } catch (error) {
      return { source: file, error: String(error.message || error), data: {} };
    }
  }
  return { source: null, data: {} };
}

function findInPath(names) {
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isFile(full)) return full;
    }
  }
  return null;
}

function listSubdirMatches(parentDir, prefix, relativeBinary) {
  if (!isDir(parentDir)) return [];
  try {
    return fs
      .readdirSync(parentDir)
      .filter((entry) => !prefix || entry.startsWith(prefix))
      .sort()
      .reverse()
      .map((entry) => path.join(parentDir, entry, relativeBinary))
      .filter(isFile);
  } catch {
    return [];
  }
}

function resolveOscript(settingsOscript) {
  if (typeof settingsOscript === 'string' && isFile(settingsOscript)) {
    return path.resolve(settingsOscript);
  }
  if (process.env.OSCRIPT_BIN && isFile(process.env.OSCRIPT_BIN)) {
    return path.resolve(process.env.OSCRIPT_BIN);
  }
  const binNames = process.platform === 'win32'
    ? ['oscript.exe', 'oscript.bat', 'oscript.cmd']
    : ['oscript'];
  const fromPath = findInPath(binNames);
  if (fromPath) return fromPath;

  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'oscript.exe' : 'oscript';
  if (home) {
    const infostartMatches = listSubdirMatches(
      path.join(home, '.local', 'share', 'infostart-tools'),
      'onescript-',
      path.join('bin', exe)
    );
    if (infostartMatches.length > 0) return infostartMatches[0];

    const ovmUnix = path.join(home, '.local', 'share', 'ovm', 'current', 'bin', exe);
    if (isFile(ovmUnix)) return ovmUnix;
    const ovmVersions = listSubdirMatches(
      path.join(home, '.local', 'share', 'ovm', 'versions'),
      '',
      path.join('bin', exe)
    );
    if (ovmVersions.length > 0) return ovmVersions[0];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const ovmWin = path.join(localAppData, 'ovm', 'current', 'bin', 'oscript.exe');
      if (isFile(ovmWin)) return ovmWin;
    }
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const stdWin = path.join(progFiles, 'OneScript', 'bin', 'oscript.exe');
    if (isFile(stdWin)) return stdWin;
  } else {
    for (const candidate of ['/usr/local/bin/oscript', '/opt/onescript/bin/oscript']) {
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveRunnerRoot(settingsRunnerRoot) {
  const candidates = [];
  if (typeof settingsRunnerRoot === 'string') candidates.push(settingsRunnerRoot);
  if (process.env.VANESSA_RUNNER_ROOT) candidates.push(process.env.VANESSA_RUNNER_ROOT);

  const pluginRoot = process.env.PLUGIN_ROOT || path.resolve(__dirname, '..');
  // Sibling checkout beside repository root when running from <repo>/.agents/plugins/1c-ai-pipeline
  candidates.push(path.resolve(pluginRoot, '..', '..', '..', 'vanessa-runner'));

  // Walk up from current working directory to discover an explicit or sibling vanessa-runner checkout
  let cursor = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push(cursor);
    candidates.push(path.join(cursor, 'vanessa-runner'));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, '.local', 'share', 'vanessa-runner'));
    candidates.push(path.join(home, 'vanessa-runner'));
  }

  for (const raw of candidates) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (isDir(resolved) && isFile(path.join(resolved, 'src', 'mcp.os'))) {
      return resolved;
    }
  }
  return null;
}

function hasRunnerDependencies(runnerRoot) {
  if (!runnerRoot) return false;
  const autumnDir = path.join(runnerRoot, 'oscript_modules', 'autumn-mcp');
  return isDir(autumnDir) && (
    isFile(path.join(autumnDir, 'packagedef')) ||
    isDir(path.join(autumnDir, 'src'))
  );
}

function buildChildEnv(baseEnv = process.env, targetPlatform = process.platform) {
  const env = { ...baseEnv };
  if (targetPlatform === 'win32' && baseEnv.SystemRoot) {
    const winPath = path.win32;
    const sysModules = winPath.join(
      baseEnv.SystemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'Modules'
    );
    const existing = (baseEnv.PSModulePath || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    const hasSysModules = existing.some(
      (part) => part.toLowerCase() === sysModules.toLowerCase()
    );
    if (!hasSysModules) {
      existing.push(sysModules);
    }
    env.PSModulePath = existing.join(';');
  }
  return env;
}

function diagnose(explicitSettingsPath) {
  const checks = [];
  const settingsInfo = readSettings(explicitSettingsPath);
  if (settingsInfo.error) {
    checks.push({ requirement: 'settings', ok: false, detail: settingsInfo.error });
  } else if (settingsInfo.source) {
    checks.push({ requirement: 'settings', ok: true, detail: settingsInfo.source });
  }

  const oscript = resolveOscript(settingsInfo.data.oscript);
  checks.push({
    requirement: 'oscript',
    ok: Boolean(oscript),
    detail: oscript || 'OneScript executable (oscript) not found; set OSCRIPT_BIN or add oscript to PATH',
  });

  const runnerRoot = resolveRunnerRoot(settingsInfo.data.runner_root);
  checks.push({
    requirement: 'runner_root',
    ok: Boolean(runnerRoot),
    detail: runnerRoot || 'vanessa-runner directory with src/mcp.os not found; set VANESSA_RUNNER_ROOT or settings.json',
  });

  const entry = runnerRoot ? path.join(runnerRoot, 'src', 'mcp.os') : null;
  const entryOk = Boolean(entry && isFile(entry));
  checks.push({
    requirement: 'entry',
    ok: entryOk,
    detail: entryOk ? entry : 'src/mcp.os is missing inside runner_root',
  });

  const depsOk = hasRunnerDependencies(runnerRoot);
  checks.push({
    requirement: 'dependencies',
    ok: depsOk,
    detail: depsOk
      ? path.join(runnerRoot, 'oscript_modules', 'autumn-mcp')
      : 'oscript_modules/autumn-mcp is missing inside runner_root; run "opm install -l" in vanessa-runner',
  });

  return { checks, oscript, runnerRoot, entry };
}

function runServer(oscript, entry, runnerRoot) {
  const env = buildChildEnv(process.env, process.platform);
  const child = spawn(oscript, [entry], {
    cwd: runnerRoot,
    stdio: 'inherit',
    env,
  });

  const forwardSignal = (sig) => {
    if (!child.killed) {
      try {
        child.kill(sig);
      } catch {
        // Ignore if child already exited
      }
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => forwardSignal(sig));
  }

  child.on('error', (error) => {
    process.stderr.write(`VanessaRunner MCP launch error: ${error.message}\n`);
    process.exit(2);
  });

  child.on('exit', (code, signal) => {
    if (typeof code === 'number') {
      process.exit(code);
    }
    process.exit(signal ? 1 : 0);
  });
}

function main(argv = process.argv.slice(2)) {
  const checking = argv.includes('--check');
  const positional = argv.filter((arg) => arg !== '--check');
  const explicitSettings = positional[0] || null;
  const { checks, oscript, runnerRoot, entry } = diagnose(explicitSettings);
  const ready = checks.every((item) => item.ok);

  if (checking) {
    process.stdout.write(JSON.stringify({ ready, checks }) + '\n');
    return ready ? 0 : 2;
  }

  if (!ready) {
    const failed = checks.find((item) => !item.ok);
    process.stderr.write(`VanessaRunner MCP configuration: ${failed.detail}\n`);
    return 2;
  }

  runServer(oscript, entry, runnerRoot);
  return null;
}

module.exports = {
  readSettings,
  resolveOscript,
  resolveRunnerRoot,
  hasRunnerDependencies,
  buildChildEnv,
  diagnose,
  main,
};

if (require.main === module) {
  const code = main();
  if (typeof code === 'number') {
    process.exit(code);
  }
}
