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

function parseSemverTuple(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] !== undefined ? Number(match[4]) : -1,
  ];
}

function compareSemverDesc(a, b) {
  const va = parseSemverTuple(a);
  const vb = parseSemverTuple(b);
  if (va && vb) {
    for (let i = 0; i < 4; i += 1) {
      if (va[i] !== vb[i]) return vb[i] - va[i];
    }
  } else if (va) {
    return -1;
  } else if (vb) {
    return 1;
  }
  return String(b).localeCompare(String(a));
}

function readSettings(explicitPath, env = process.env, platform = process.platform, homedir = os.homedir()) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (env.PLUGIN_DATA) {
    candidates.push(path.join(env.PLUGIN_DATA, 'settings.json'));
  }
  if (platform === 'win32' && env.APPDATA) {
    candidates.push(path.join(env.APPDATA, '1c-ai-pipeline', 'settings.json'));
  } else if (homedir) {
    candidates.push(path.join(homedir, '.config', '1c-ai-pipeline', 'settings.json'));
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

function findInPath(names, env = process.env, platform = process.platform) {
  const pathEnv = env.PATH || env.Path || '';
  const delim = platform === 'win32' ? ';' : path.delimiter;
  const dirs = pathEnv
    .split(delim)
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
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
      .sort(compareSemverDesc)
      .map((entry) => path.join(parentDir, entry, relativeBinary))
      .filter(isFile);
  } catch {
    return [];
  }
}

function resolveOscript(settingsOscript, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.homedir !== undefined ? options.homedir : os.homedir();

  if (typeof settingsOscript === 'string' && isFile(settingsOscript)) {
    return path.resolve(settingsOscript);
  }
  if (env.OSCRIPT_BIN && isFile(env.OSCRIPT_BIN)) {
    return path.resolve(env.OSCRIPT_BIN);
  }
  if (env.OVM_OSCRIPTBIN) {
    const ovmBinExe = path.join(env.OVM_OSCRIPTBIN, platform === 'win32' ? 'oscript.exe' : 'oscript');
    if (isFile(ovmBinExe)) return path.resolve(ovmBinExe);
  }

  const binNames = platform === 'win32'
    ? ['oscript.exe', 'oscript.bat', 'oscript.cmd']
    : ['oscript'];
  const fromPath = findInPath(binNames, env, platform);
  if (fromPath) return fromPath;

  const exe = platform === 'win32' ? 'oscript.exe' : 'oscript';
  const binRel = path.join('bin', exe);

  if (platform === 'win32') {
    const winRoots = [];
    if (env.LOCALAPPDATA) winRoots.push(path.join(env.LOCALAPPDATA, 'ovm'));
    if (env.USERPROFILE) {
      winRoots.push(path.join(env.USERPROFILE, 'AppData', 'Local', 'ovm'));
      winRoots.push(path.join(env.USERPROFILE, '.local', 'share', 'ovm'));
    }
    if (home) {
      winRoots.push(path.join(home, 'AppData', 'Local', 'ovm'));
      winRoots.push(path.join(home, '.local', 'share', 'ovm'));
    }

    for (const ovmRoot of winRoots) {
      for (const alias of ['current', 'stable']) {
        const aliasExe = path.join(ovmRoot, alias, binRel);
        if (isFile(aliasExe)) return aliasExe;
      }
      const inVersions = listSubdirMatches(path.join(ovmRoot, 'versions'), '', binRel);
      if (inVersions.length > 0) return inVersions[0];

      // On Windows, `ovm install 2.2.1` places versions directly in `%LOCALAPPDATA%\ovm\2.2.1\bin\oscript.exe`
      const directVersions = listSubdirMatches(ovmRoot, '', binRel).filter((candidate) => {
        const folder = path.basename(path.dirname(path.dirname(candidate)));
        return Boolean(parseSemverTuple(folder));
      });
      if (directVersions.length > 0) return directVersions[0];
    }

    const progFilesCandidates = [
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'],
    ].filter(Boolean);
    for (const progRoot of progFilesCandidates) {
      const stdWin = path.join(progRoot, 'OneScript', 'bin', 'oscript.exe');
      if (isFile(stdWin)) return stdWin;
    }
  } else {
    if (home) {
      const infostartMatches = listSubdirMatches(
        path.join(home, '.local', 'share', 'infostart-tools'),
        'onescript-',
        binRel
      );
      if (infostartMatches.length > 0) return infostartMatches[0];

      const ovmRoot = path.join(home, '.local', 'share', 'ovm');
      for (const alias of ['current', 'stable']) {
        const ovmAlias = path.join(ovmRoot, alias, binRel);
        if (isFile(ovmAlias)) return ovmAlias;
      }
      const ovmVersions = listSubdirMatches(path.join(ovmRoot, 'versions'), '', binRel);
      if (ovmVersions.length > 0) return ovmVersions[0];

      const ovmDirect = listSubdirMatches(ovmRoot, '', binRel).filter((candidate) => {
        const folder = path.basename(path.dirname(path.dirname(candidate)));
        return Boolean(parseSemverTuple(folder));
      });
      if (ovmDirect.length > 0) return ovmDirect[0];
    }

    for (const candidate of ['/usr/local/bin/oscript', '/opt/onescript/bin/oscript', '/usr/bin/oscript']) {
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveRunnerRoot(settingsRunnerRoot, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const home = options.homedir !== undefined ? options.homedir : os.homedir();

  const candidates = [];
  if (typeof settingsRunnerRoot === 'string') candidates.push(settingsRunnerRoot);
  if (env.VANESSA_RUNNER_ROOT) candidates.push(env.VANESSA_RUNNER_ROOT);

  const pluginRoot = env.PLUGIN_ROOT || path.resolve(__dirname, '..');
  // Sibling checkout beside repository root when running from <repo>/.agents/plugins/1c-ai-pipeline
  candidates.push(path.resolve(pluginRoot, '..', '..', '..', 'vanessa-runner'));

  // Walk up from current working directory to discover an explicit or sibling vanessa-runner checkout
  let cursor = cwd;
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push(cursor);
    candidates.push(path.join(cursor, 'vanessa-runner'));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (home) {
    candidates.push(path.join(home, 'tools', 'vanessa-ai-pipeline', 'vanessa-runner'));
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

function diagnose(explicitSettingsPath, options = {}) {
  const checks = [];
  const settingsInfo = readSettings(
    explicitSettingsPath,
    options.env,
    options.platform,
    options.homedir
  );
  if (settingsInfo.error) {
    checks.push({ requirement: 'settings', ok: false, detail: settingsInfo.error });
  } else if (settingsInfo.source) {
    checks.push({ requirement: 'settings', ok: true, detail: settingsInfo.source });
  }

  const oscript = resolveOscript(settingsInfo.data.oscript, options);
  checks.push({
    requirement: 'oscript',
    ok: Boolean(oscript),
    detail: oscript || 'OneScript executable (oscript) not found; set OSCRIPT_BIN, settings.json "oscript", or install via ovm',
  });

  const runnerRoot = resolveRunnerRoot(settingsInfo.data.runner_root, options);
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
      : 'oscript_modules/autumn-mcp is missing inside runner_root; run "mise run setup" or "opm install -l" in vanessa-runner',
  });

  return { checks, oscript, runnerRoot, entry, settingsInfo };
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
  isFile,
  isDir,
  parseSemverTuple,
  compareSemverDesc,
  readSettings,
  findInPath,
  listSubdirMatches,
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
