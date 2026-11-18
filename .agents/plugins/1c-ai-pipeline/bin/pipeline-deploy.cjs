#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const runnerMcp = require('./vanessa-runner-mcp.cjs');

const {
  isFile,
  isDir,
  compareSemverDesc,
  readSettings,
  findInPath,
  resolveOscript,
  resolveRunnerRoot,
  hasRunnerDependencies,
  buildChildEnv,
  diagnose: diagnoseRunnerLauncher,
} = runnerMcp;

const FORK_REPOS = [
  {
    dir: 'edt-mcp',
    origin: 'https://github.com/infostart-hub/edt-mcp-aiadopted.git',
    upstream: 'https://github.com/DitriXNew/EDT-MCP.git',
  },
  {
    dir: 'vanessa-runner',
    origin: 'https://github.com/infostart-hub/vanessa-runner-aiadopted.git',
    upstream: 'https://github.com/vanessa-opensource/vanessa-runner.git',
  },
  {
    dir: 'vanessa-automation',
    origin: 'https://github.com/infostart-hub/vanessa-automation-aiadopted.git',
    upstream: 'https://github.com/Pr-Mex/vanessa-automation.git',
  },
];

const EDT_FEATURE_ID = 'com.ditrix.edt.mcp.server.feature.feature.group';
const EDT_BUNDLE_PREFIX = 'com.ditrix.edt.mcp.server,';
const EDT_RELEASE_API_URL = 'https://api.github.com/repos/infostart-hub/edt-mcp-aiadopted/releases/latest';

const OFFICIAL_EDT_DOWNLOAD = {
  landingUrl: 'https://edt.1c.ru/',
  releasesUrl: 'https://releases.1c.ru/project/DevelopmentTools10',
  communityLicenseUrl: 'https://developer.1c.ru/',
  supportedSeries: ['2025.2', '2026.1', '2026.2'],
  summaryRu:
    'Дистрибутив 1C:EDT Start и 1С:EDT скачивается бесплатно с https://edt.1c.ru/ или https://releases.1c.ru/project/DevelopmentTools10 по обычной бесплатной учётной записи portal.1c.ru (платный договор ИТС для скачивания EDT не требуется). Через 1C:EDT Start установите 1С:EDT 2025.2, 2026.1 или 2026.2 (нужная Java с JavaFX ставится автоматически). Бесплатная комьюнити-лицензия разработчика 1С при необходимости оформляется на https://developer.1c.ru/.',
};

const ALLOWED_BROWSER_TARGETS = {
  edt: OFFICIAL_EDT_DOWNLOAD.landingUrl,
  releases: OFFICIAL_EDT_DOWNLOAD.releasesUrl,
  license: OFFICIAL_EDT_DOWNLOAD.communityLicenseUrl,
};

function defaultSettingsPath(env = process.env, platform = process.platform, homedir = os.homedir()) {
  if (env.PLUGIN_DATA) {
    return path.join(env.PLUGIN_DATA, 'settings.json');
  }
  if (platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, '1c-ai-pipeline', 'settings.json');
  }
  return path.join(homedir || '.', '.config', '1c-ai-pipeline', 'settings.json');
}

function writeMergedSettings(updates, explicitPath, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir !== undefined ? options.homedir : os.homedir();
  const existing = readSettings(explicitPath, env, platform, homedir);
  const targetFile = existing.source || explicitPath || defaultSettingsPath(env, platform, homedir);
  const merged = { ...(existing.data || {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = value;
    }
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return { path: targetFile, data: merged };
}

function findRepoCloneRoot(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const pluginRoot = env.PLUGIN_ROOT || path.resolve(__dirname, '..');
  const candidates = [
    options.repoRoot,
    path.resolve(pluginRoot, '..', '..', '..'),
    cwd,
  ].filter(Boolean);

  for (const raw of candidates) {
    const resolved = path.resolve(raw);
    if (
      isFile(path.join(resolved, 'LLMINSTALL.md')) &&
      isDir(path.join(resolved, '.agents', 'plugins', '1c-ai-pipeline'))
    ) {
      return resolved;
    }
  }
  return null;
}

function resolveMiseBinary(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir !== undefined ? options.homedir : os.homedir();

  const names = platform === 'win32' ? ['mise.exe', 'mise.cmd', 'mise.bat'] : ['mise'];
  const inPath = findInPath(names, env, platform);
  if (inPath) return inPath;

  const extra = [];
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      extra.push(path.join(env.LOCALAPPDATA, 'mise', 'bin', 'mise.exe'));
      extra.push(path.join(env.LOCALAPPDATA, 'Programs', 'mise', 'bin', 'mise.exe'));
      const wingetPkgs = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
      if (isDir(wingetPkgs)) {
        try {
          for (const entry of fs.readdirSync(wingetPkgs)) {
            if (entry.toLowerCase().startsWith('jdx.mise')) {
              extra.push(path.join(wingetPkgs, entry, 'mise', 'bin', 'mise.exe'));
              extra.push(path.join(wingetPkgs, entry, 'mise.exe'));
            }
          }
        } catch {
          // Ignore unreadable dir
        }
      }
    }
  } else if (homedir) {
    extra.push(path.join(homedir, '.local', 'bin', 'mise'));
    extra.push('/opt/homebrew/bin/mise');
    extra.push('/usr/local/bin/mise');
  }

  for (const candidate of extra) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function getMiseShimsDir(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir !== undefined ? options.homedir : os.homedir();
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || (homedir ? path.join(homedir, 'AppData', 'Local') : null);
    return base ? path.join(base, 'mise', 'shims') : null;
  }
  return homedir ? path.join(homedir, '.local', 'share', 'mise', 'shims') : null;
}

function checkExecutableRuns(binPath, args = ['--version'], options = {}) {
  if (!binPath || !isFile(binPath)) {
    return { ok: false, stdout: '', stderr: 'file not found' };
  }
  const platform = options.platform || process.platform;
  const ext = path.extname(binPath).toLowerCase();
  const needsShell = platform === 'win32' && (ext === '.cmd' || ext === '.bat');
  try {
    const res = spawnSync(binPath, args, {
      encoding: 'utf8',
      timeout: options.timeout || 5000,
      shell: needsShell,
      windowsHide: true,
      env: options.env || process.env,
    });
    if (res.error) {
      return { ok: false, stdout: res.stdout || '', stderr: String(res.error.message || res.error) };
    }
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error.message || error) };
  }
}

function inspectNodeAndPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const names = platform === 'win32' ? ['node.exe', 'node.cmd', 'node.bat'] : ['node'];
  const firstNodeInPath = findInPath(names, env, platform);
  const probe = firstNodeInPath
    ? (options.probeCommand ? options.probeCommand(firstNodeInPath, ['--version']) : checkExecutableRuns(firstNodeInPath, ['--version'], { env, platform }))
    : { ok: false, stdout: '', stderr: 'node not found in PATH' };

  const majorMatch = (probe.stdout || '').match(/^v?(\d+)\./);
  const pathNodeMajor = majorMatch ? Number(majorMatch[1]) : null;
  const pathNodeHealthy = Boolean(probe.ok && pathNodeMajor && pathNodeMajor >= 18);

  const miseBin = resolveMiseBinary(options);
  const shimsDir = getMiseShimsDir(options);
  const shimNode = shimsDir
    ? path.join(shimsDir, platform === 'win32' ? 'node.exe' : 'node')
    : null;
  const shimNodeExists = Boolean(shimNode && isFile(shimNode));

  return {
    currentProcessNode: process.execPath,
    currentProcessVersion: process.version,
    firstNodeInPath,
    pathNodeHealthy,
    pathNodeVersion: probe.ok ? probe.stdout : null,
    pathNodeError: probe.ok ? null : (probe.stderr || probe.stdout || 'node in PATH failed'),
    miseBinary: miseBin,
    miseShimsDir: shimsDir,
    shimNode: shimNodeExists ? shimNode : null,
  };
}

function fixWindowsUserPathForMise(shimsDir, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || !shimsDir || !isDir(shimsDir)) {
    return { changed: false, reason: 'not_applicable' };
  }
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "$shim = $env:PIPELINE_MISE_SHIMS",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
    "$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "$parts = @($raw -split ';' | Where-Object { $_ -and $_.Trim() -ne '' })",
    "$ filtered = @($parts | Where-Object { $_.Trim().TrimEnd('\\') -ieq $shim.Trim().TrimEnd('\\') })",
    "if ($parts.Count -gt 0 -and $parts[0].Trim().TrimEnd('\\') -ieq $shim.Trim().TrimEnd('\\')) { Write-Output 'UNCHANGED'; exit 0 }",
    "$rest = @($parts | Where-Object { $_.Trim().TrimEnd('\\') -ine $shim.Trim().TrimEnd('\\') })",
    "$newPath = (@($shim) + $rest) -join ';'",
    "$key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    "Write-Output 'UPDATED'",
  ].join('; ').replace('$ filtered', '$filtered');

  const res = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    env: { ...(options.env || process.env), PIPELINE_MISE_SHIMS: shimsDir },
  });
  const out = (res.stdout || '').trim();
  if (res.status === 0 && out.includes('UPDATED')) {
    return { changed: true, restartClientRequired: true };
  }
  if (res.status === 0) {
    return { changed: false, restartClientRequired: false };
  }
  return { changed: false, error: (res.stderr || out || 'failed to update User Path').trim() };
}

function resolveGitBinary(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const probeFn = options.probeCommand || ((bin, args) => checkExecutableRuns(bin, args, { env, platform }));

  const names = platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
  const inPath = findInPath(names, env, platform);
  const candidates = [];
  if (inPath) candidates.push(inPath);
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(pf, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(pf86, 'Git', 'cmd', 'git.exe'));
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
    }
  } else {
    candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git');
  }
  for (const cand of candidates) {
    if (cand && isFile(cand)) {
      const check = probeFn(cand, ['--version']);
      if (check.ok) return cand;
    }
  }
  return null;
}

function ensureGitOnWindows(options = {}) {
  const existing = resolveGitBinary(options);
  if (existing) {
    return { ok: true, status: 'already_present', executable: existing };
  }
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || options.autoInstallGit === false) {
    return { ok: false, status: 'missing', executable: null };
  }
  const installerFn = options.installGitFn || (() => {
    return spawnSync(
      'winget',
      ['install', '--id', 'Git.Git', '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent'],
      { encoding: 'utf8', windowsHide: true, timeout: 300000 }
    );
  });
  try {
    const installRes = installerFn();
    const afterBin = resolveGitBinary(options);
    if (afterBin) {
      return { ok: true, status: 'installed_via_winget', executable: afterBin };
    }
    const errText = ((installRes && (installRes.stderr || installRes.stdout)) || '').trim();
    return {
      ok: false,
      status: 'install_failed',
      executable: null,
      detail: errText || 'winget install Git.Git did not produce git.exe (запустите команду вне песочницы)',
    };
  } catch (error) {
    return { ok: false, status: 'install_failed', executable: null, detail: String(error.message || error) };
  }
}

function isSandboxLoopbackError(text) {
  return /Unable to establish loopback connection|Operation not permitted.*loopback|Permission denied.*127\.0\.0\.1/i.test(
    String(text || '')
  );
}

function extractEdtVersion(exePath) {
  if (!exePath) return null;
  const m = String(exePath).match(/(20\d{2}\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

function isEdtVersionSupported(versionStr) {
  if (!versionStr) return true;
  const parts = String(versionStr).split('.').map((n) => Number(n));
  const year = parts[0];
  const minor = parts[1] || 0;
  if (!Number.isFinite(year)) return true;
  return year > 2025 || (year === 2025 && minor >= 2);
}

function inspectGitIdentity(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const gitBin = options.gitExecutable !== undefined ? options.gitExecutable : resolveGitBinary(options);
  if (!gitBin) {
    return {
      gitInstalled: false,
      gitExecutable: null,
      userName: null,
      userEmail: null,
      configured: false,
      promptQuestionRu:
        'Как вас зовут (Имя и Фамилия) и какой у вас корпоративный e-mail? (Я сам настрою автора изменений для работы с конфигурацией 1С)',
    };
  }

  const runGitCfg = (key) => {
    const res = spawnSync(gitBin, ['config', '--global', '--get', key], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      env,
      shell: platform === 'win32' && /\.(cmd|bat)$/i.test(gitBin),
    });
    return res.status === 0 ? (res.stdout || '').trim() || null : null;
  };

  const userName = runGitCfg('user.name');
  const userEmail = runGitCfg('user.email');
  const configured = Boolean(userName && userEmail);

  return {
    gitInstalled: true,
    gitExecutable: gitBin,
    userName,
    userEmail,
    configured,
    promptQuestionRu: configured
      ? null
      : 'Как вас зовут (Имя и Фамилия) и какой у вас корпоративный e-mail? (Я сам настрою автора изменений для работы с конфигурацией 1С)',
  };
}

function configureGitIdentity(name, email, options = {}) {
  const trimmedName = String(name || '').trim();
  const trimmedEmail = String(email || '').trim();
  if (!trimmedName) {
    return { ok: false, error: 'Не указано имя (user.name).' };
  }
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return { ok: false, error: 'Не указан корректный корпоративный e-mail (user.email).' };
  }
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const gitBin = options.gitExecutable !== undefined ? options.gitExecutable : resolveGitBinary(options);
  if (!gitBin) {
    return { ok: false, error: 'Git не найден на компьютере. Сначала установите Git.' };
  }
  const execOpts = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    env,
    shell: platform === 'win32' && /\.(cmd|bat)$/i.test(gitBin),
  };

  const r1 = spawnSync(gitBin, ['config', '--global', 'user.name', trimmedName], execOpts);
  const r2 = spawnSync(gitBin, ['config', '--global', 'user.email', trimmedEmail], execOpts);
  // Keep Cyrillic 1C metadata filenames readable in git status / diff
  spawnSync(gitBin, ['config', '--global', 'core.quotepath', 'false'], execOpts);

  if (r1.status !== 0 || r2.status !== 0) {
    return {
      ok: false,
      error: ((r1.stderr || '') + ' ' + (r2.stderr || '')).trim() || 'git config failed',
    };
  }
  const verified = inspectGitIdentity({ ...options, gitExecutable: gitBin });
  return { ok: verified.configured, ...verified };
}

function openUrlInSystemBrowser(targetKeyOrUrl = 'edt', options = {}) {
  const resolvedUrl = ALLOWED_BROWSER_TARGETS[targetKeyOrUrl] || targetKeyOrUrl;
  const allowedSet = new Set(Object.values(ALLOWED_BROWSER_TARGETS));
  if (!allowedSet.has(resolvedUrl)) {
    return {
      ok: false,
      url: resolvedUrl,
      error: `URL is not in allowlist (${Array.from(allowedSet).join(', ')})`,
    };
  }
  const platform = options.platform || process.platform;
  if (typeof options.openBrowserFn === 'function') {
    const custom = options.openBrowserFn(resolvedUrl, platform);
    return { ok: Boolean(custom && custom.ok !== false), url: resolvedUrl, ...custom };
  }
  try {
    let res;
    if (platform === 'win32') {
      res = spawnSync('rundll32.exe', ['url.dll,FileProtocolHandler', resolvedUrl], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
    } else if (platform === 'darwin') {
      res = spawnSync('open', [resolvedUrl], { encoding: 'utf8', timeout: 10000 });
    } else {
      res = spawnSync('xdg-open', [resolvedUrl], { encoding: 'utf8', timeout: 10000 });
    }
    return {
      ok: res.status === 0,
      url: resolvedUrl,
      error: res.status === 0 ? null : ((res.stderr || res.stdout || `exit ${res.status}`).trim()),
    };
  } catch (error) {
    return { ok: false, url: resolvedUrl, error: String(error.message || error) };
  }
}

function discoverAiClients(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir !== undefined ? options.homedir : os.homedir();
  const probeFn = options.probeCommand || ((bin, args) => checkExecutableRuns(bin, args, { env, platform }));

  // Discover Codex (skipping broken WinGet AppExecutionAlias symlinks)
  const codexCandidates = [];
  const delim = platform === 'win32' ? ';' : path.delimiter;
  for (const dir of (env.PATH || env.Path || '').split(delim).map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const name of (platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'])) {
      const full = path.join(dir, name);
      if (isFile(full)) codexCandidates.push(full);
    }
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const codexDesktopBin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (isDir(codexDesktopBin)) {
      try {
        for (const sub of fs.readdirSync(codexDesktopBin).sort(compareSemverDesc)) {
          const exe = path.join(codexDesktopBin, sub, 'codex.exe');
          if (isFile(exe)) codexCandidates.push(exe);
        }
      } catch {
        // Ignore
      }
    }
  } else if (platform === 'darwin') {
    for (const appRoot of ['/Applications', homedir ? path.join(homedir, 'Applications') : null].filter(Boolean)) {
      const macChatGptCodex = path.join(appRoot, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin', 'codex');
      const macCodexApp = path.join(appRoot, 'Codex.app', 'Contents', 'Resources', 'codex');
      if (isFile(macChatGptCodex)) codexCandidates.push(macChatGptCodex);
      if (isFile(macCodexApp)) codexCandidates.push(macCodexApp);
    }
  }

  let workingCodex = null;
  for (const cand of [...new Set(codexCandidates)]) {
    const check = probeFn(cand, ['--version']);
    if (check.ok) {
      workingCodex = { executable: cand, version: check.stdout };
      break;
    }
  }

  const claudeCand = findInPath(platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'], env, platform);
  const claudeCheck = claudeCand ? probeFn(claudeCand, ['--version']) : { ok: false };

  const cursorCand = findInPath(platform === 'win32' ? ['cursor.cmd', 'cursor.exe'] : ['cursor'], env, platform);

  return {
    codex: {
      available: Boolean(workingCodex),
      executable: workingCodex ? workingCodex.executable : null,
      version: workingCodex ? workingCodex.version : null,
      configDir: homedir ? path.join(homedir, '.codex') : null,
    },
    claude: {
      available: Boolean(claudeCheck.ok),
      executable: claudeCheck.ok ? claudeCand : null,
      version: claudeCheck.ok ? claudeCheck.stdout : null,
    },
    cursor: {
      available: Boolean(cursorCand),
      executable: cursorCand || null,
    },
  };
}

function discoverPlatforms(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const verRe = /^\d+\.\d+\.\d+\.\d+$/;
  const found = new Map();

  const roots = options.platformRoots || (
    platform === 'win32'
      ? [
          path.join(env.ProgramFiles || 'C:\\Program Files', '1cv8'),
          env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], '1cv8') : null,
        ].filter(Boolean)
      : ['/opt/1cv8', '/opt/1C/v8.3']
  );

  for (const root of roots) {
    if (!isDir(root)) continue;
    try {
      for (const entry of fs.readdirSync(root)) {
        const sub = path.join(root, entry);
        if (!isDir(sub)) continue;
        if (verRe.test(entry)) {
          const exe = platform === 'win32'
            ? path.join(sub, 'bin', '1cv8.exe')
            : (isFile(path.join(sub, '1cv8')) ? path.join(sub, '1cv8') : path.join(sub, 'bin', '1cv8'));
          if (isFile(exe) && !found.has(entry)) {
            found.set(entry, exe);
          }
        } else {
          // Linux architecture nesting: /opt/1cv8/x86_64/8.3.27.2325/1cv8
          for (const nested of fs.readdirSync(sub)) {
            if (!verRe.test(nested)) continue;
            const nestedDir = path.join(sub, nested);
            const exe = isFile(path.join(nestedDir, '1cv8'))
              ? path.join(nestedDir, '1cv8')
              : path.join(nestedDir, 'bin', '1cv8');
            if (isFile(exe) && !found.has(nested)) {
              found.set(nested, exe);
            }
          }
        }
      }
    } catch {
      // Ignore unreadable root
    }
  }

  return [...found.entries()]
    .sort((a, b) => compareSemverDesc(a[0], b[0]))
    .map(([version, clientPath]) => ({ version, clientPath }));
}

function parseEdtIniVm(edtExecutable, platform = process.platform) {
  if (!edtExecutable) return null;
  const edtDir = path.dirname(edtExecutable);
  const iniCandidates = [
    path.join(edtDir, '1cedt.ini'),
    // macOS app bundle layout: .../1cedt.app/Contents/MacOS/1cedt -> ../Eclipse/1cedt.ini
    path.resolve(edtDir, '..', 'Eclipse', '1cedt.ini'),
  ];
  for (const iniPath of iniCandidates) {
    if (!isFile(iniPath)) continue;
    try {
      const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/).map((l) => l.trim());
      const vmIdx = lines.indexOf('-vm');
      if (vmIdx !== -1 && vmIdx + 1 < lines.length) {
        const rawVm = lines[vmIdx + 1];
        const resolvedVm = path.isAbsolute(rawVm)
          ? rawVm
          : path.resolve(path.dirname(iniPath), rawVm);
        // If -vm points to jvm.dll / libjvm.dylib / bin/server/..., walk up to JAVA_HOME/bin/java(w)
        let cursor = isFile(resolvedVm) ? path.dirname(resolvedVm) : resolvedVm;
        for (let depth = 0; depth < 4; depth += 1) {
          const candidates = platform === 'win32'
            ? [path.join(cursor, 'javaw.exe'), path.join(cursor, 'bin', 'javaw.exe'), path.join(cursor, 'java.exe'), path.join(cursor, 'bin', 'java.exe')]
            : [path.join(cursor, 'java'), path.join(cursor, 'bin', 'java')];
          for (const javaBin of candidates) {
            if (isFile(javaBin)) return javaBin;
          }
          const parent = path.dirname(cursor);
          if (parent === cursor) break;
          cursor = parent;
        }
      }
    } catch {
      // Continue
    }
  }
  return null;
}

function inspectEdtBundlesInfo(edtExecutable) {
  if (!edtExecutable) return { installed: false, bundleVersion: null, bundlesInfoPath: null };
  const edtDir = path.dirname(edtExecutable);
  const candidates = [
    path.join(edtDir, 'configuration', 'org.eclipse.equinox.simpleconfigurator', 'bundles.info'),
    path.resolve(edtDir, '..', 'Eclipse', 'configuration', 'org.eclipse.equinox.simpleconfigurator', 'bundles.info'),
  ];
  for (const infoPath of candidates) {
    if (!isFile(infoPath)) continue;
    try {
      const lines = fs.readFileSync(infoPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith(EDT_BUNDLE_PREFIX)) {
          const parts = line.split(',');
          return {
            installed: true,
            bundleVersion: parts[1] || null,
            bundlesInfoPath: infoPath,
          };
        }
      }
      return { installed: false, bundleVersion: null, bundlesInfoPath: infoPath };
    } catch {
      // Ignore
    }
  }
  return { installed: false, bundleVersion: null, bundlesInfoPath: null };
}

function walkForFile(rootDir, targetNames, maxDepth = 4) {
  const results = [];
  function visit(dir, depth) {
    if (depth > maxDepth || !isDir(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && targetNames.includes(entry.name)) {
        results.push(full);
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        visit(full, depth + 1);
      }
    }
  }
  visit(rootDir, 0);
  return results;
}

function readEdtWorkspacePrefs(options = {}) {
  const env = options.env || process.env;
  const homedir = options.homedir !== undefined ? options.homedir : os.homedir();
  const prefsRel = path.join(
    '.metadata',
    '.plugins',
    'org.eclipse.core.runtime',
    '.settings',
    'com.ditrix.edt.mcp.server.prefs'
  );
  const workspaceCandidates = new Set();
  if (options.workspaceDirs) {
    for (const dir of options.workspaceDirs) workspaceCandidates.add(dir);
  }
  if (env.EDT_WORKSPACE) workspaceCandidates.add(env.EDT_WORKSPACE);
  if (homedir) {
    workspaceCandidates.add(path.join(homedir, 'workspace'));
    workspaceCandidates.add(path.join(homedir, '1C_EDT_Workspace'));
    workspaceCandidates.add(path.join(homedir, 'edt-workspace'));
  }
  if (env.LOCALAPPDATA) {
    workspaceCandidates.add(path.join(env.LOCALAPPDATA, '1C', 'EDT-MCP', 'workspace'));
  }

  // Also inspect 1cedtstart workspaces registry if present
  const edtStartRoots = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, '1C', '1cedtstart') : null,
    env.APPDATA ? path.join(env.APPDATA, '1C', '1cedtstart') : null,
    homedir ? path.join(homedir, '.1cedtstart') : null,
    homedir ? path.join(homedir, '.local', 'share', '1C', '1cedtstart') : null,
    homedir ? path.join(homedir, 'Library', 'Application Support', '1C', '1cedtstart') : null,
  ].filter(Boolean);

  for (const root of edtStartRoots) {
    if (!isDir(root)) continue;
    try {
      for (const fname of fs.readdirSync(root)) {
        if (!fname.endsWith('.json') && !fname.endsWith('.yaml') && !fname.endsWith('.yml') && !fname.endsWith('.ini')) continue;
        const content = fs.readFileSync(path.join(root, fname), 'utf8');
        const pathMatches = content.match(/(?:[A-Za-z]:[\\/][^\r\n"']+|\/Users\/[^\r\n"']+|\/home\/[^\r\n"']+)/g) || [];
        for (const matched of pathMatches) {
          if (isDir(matched) && isDir(path.join(matched, '.metadata'))) {
            workspaceCandidates.add(matched);
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  const discovered = [];
  for (const ws of workspaceCandidates) {
    if (!ws || !isDir(ws)) continue;
    const prefsFile = path.join(ws, prefsRel);
    if (!isFile(prefsFile)) {
      if (isDir(path.join(ws, '.metadata'))) {
        discovered.push({ workspace: ws, prefsFile: null, port: null, autoStart: null });
      }
      continue;
    }
    try {
      const raw = fs.readFileSync(prefsFile, 'utf8');
      const portMatch = raw.match(/^port=(\d+)/m);
      const autoMatch = raw.match(/^autoStart=(true|false)/m);
      discovered.push({
        workspace: ws,
        prefsFile,
        port: portMatch ? Number(portMatch[1]) : null,
        autoStart: autoMatch ? autoMatch[1] === 'true' : null,
      });
    } catch {
      // Ignore
    }
  }
  return discovered;
}

function discoverEdtInstallation(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir !== undefined ? options.homedir : os.homedir();
  const exeNames = platform === 'win32' ? ['1cedt.exe'] : ['1cedt'];

  let candidates = [];
  if (options.edtExe && isFile(options.edtExe)) {
    candidates.push(path.resolve(options.edtExe));
  } else if (env.EDT_EXE && isFile(env.EDT_EXE)) {
    candidates.push(path.resolve(env.EDT_EXE));
  } else {
    const searchRoots = options.edtSearchRoots || (
      platform === 'win32'
        ? [
            env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, '1C', '1cedtstart', 'installations') : null,
            env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, '1C', '1CE', 'components') : null,
            env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', '1C', '1CE', 'components') : null,
            env.APPDATA ? path.join(env.APPDATA, '1C', '1cedtstart', 'installations') : null,
            path.join(env.ProgramFiles || 'C:\\Program Files', '1C', '1CE', 'components'),
            env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], '1C', '1CE', 'components') : null,
            'C:\\1C\\1CE\\components',
            'D:\\1C\\1CE\\components',
          ].filter(Boolean)
        : platform === 'darwin'
          ? [
              '/Applications/1C/1CE/components',
              homedir ? path.join(homedir, 'Applications', '1C', '1CE', 'components') : null,
              '/opt/1C/1CE/components',
              homedir ? path.join(homedir, 'Library', 'Application Support', '1C', '1cedtstart', 'installations') : null,
            ].filter(Boolean)
          : [
              '/opt/1C/1CE/components',
              homedir ? path.join(homedir, '1C', '1CE', 'components') : null,
              homedir ? path.join(homedir, '.local', 'share', '1C', '1cedtstart', 'installations') : null,
            ].filter(Boolean)
    );

    if (platform === 'darwin') {
      for (const appRoot of ['/Applications', homedir ? path.join(homedir, 'Applications') : null].filter(Boolean)) {
        if (!isDir(appRoot)) continue;
        try {
          for (const entry of fs.readdirSync(appRoot)) {
            if (/edt/i.test(entry) && entry.endsWith('.app')) {
              searchRoots.push(path.join(appRoot, entry));
            }
          }
        } catch {
          // Ignore
        }
      }
    } else if (platform === 'win32' && !options.edtSearchRoots) {
      // Check Windows Uninstall registry for custom 1C:EDT install locations
      const psReg = spawnSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'EDT|Enterprise Development Tools' -and $_.InstallLocation } | Select-Object -ExpandProperty InstallLocation",
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 4000 }
      );
      if (psReg.status === 0 && psReg.stdout) {
        for (const loc of psReg.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          if (isDir(loc)) searchRoots.push(loc);
        }
      }
    }

    for (const root of searchRoots) {
      candidates.push(...walkForFile(root, exeNames, 6));
    }
  }

  candidates = [...new Set(candidates)].sort((a, b) => compareSemverDesc(a, b));
  const workspaces = readEdtWorkspacePrefs(options);
  if (candidates.length === 0) {
    return {
      installed: false,
      unsupportedOnly: false,
      unsupportedVersions: [],
      executable: null,
      javaExecutable: null,
      pluginInstalled: false,
      allSupportedHavePlugin: false,
      pluginVersion: null,
      supportedInstallations: [],
      unsupportedInstallations: [],
      workspaces,
      officialDownload: OFFICIAL_EDT_DOWNLOAD,
    };
  }

  const resolveJvmForEdt = (exe) => {
    let jvm = env.EDT_JAVA && isFile(env.EDT_JAVA)
      ? path.resolve(env.EDT_JAVA)
      : parseEdtIniVm(exe, platform);
    if (!jvm && platform === 'win32') {
      const compRoot = path.join(env.ProgramFiles || 'C:\\Program Files', '1C', '1CE', 'components');
      if (isDir(compRoot)) {
        const jdkDirs = fs.readdirSync(compRoot)
          .filter((name) => name.startsWith('axiom-jdk-full-') || name.startsWith('liberica-jdk-'))
          .sort(compareSemverDesc);
        for (const jdk of jdkDirs) {
          const javaw = path.join(compRoot, jdk, 'bin', 'javaw.exe');
          if (isFile(javaw)) {
            jvm = javaw;
            break;
          }
        }
      }
    }
    return jvm;
  };

  const allInstallations = candidates.map((exe) => {
    const ver = extractEdtVersion(exe);
    const supported = isEdtVersionSupported(ver);
    const bundle = inspectEdtBundlesInfo(exe);
    return {
      executable: exe,
      version: ver,
      supported,
      javaExecutable: resolveJvmForEdt(exe),
      pluginInstalled: bundle.installed,
      pluginVersion: bundle.bundleVersion,
      bundlesInfoPath: bundle.bundlesInfoPath,
    };
  });

  const supportedInstallations = allInstallations.filter((inst) => inst.supported);
  const unsupportedInstallations = allInstallations.filter((inst) => !inst.supported);

  if (supportedInstallations.length === 0) {
    return {
      installed: false,
      unsupportedOnly: true,
      unsupportedVersions: unsupportedInstallations.map((u) => u.version || u.executable),
      executable: null,
      allExecutables: candidates,
      javaExecutable: null,
      pluginInstalled: false,
      allSupportedHavePlugin: false,
      pluginVersion: null,
      supportedInstallations: [],
      unsupportedInstallations,
      workspaces,
      officialDownload: OFFICIAL_EDT_DOWNLOAD,
    };
  }

  const primary = supportedInstallations[0];
  const allSupportedHavePlugin = supportedInstallations.every((inst) => inst.pluginInstalled);
  const anySupportedHasPlugin = supportedInstallations.some((inst) => inst.pluginInstalled);

  return {
    installed: true,
    unsupportedOnly: false,
    executable: primary.executable,
    version: primary.version,
    allExecutables: candidates,
    supportedInstallations,
    unsupportedInstallations,
    javaExecutable: primary.javaExecutable,
    pluginInstalled: anySupportedHasPlugin,
    allSupportedHavePlugin,
    pluginVersion: primary.pluginVersion || (supportedInstallations.find((i) => i.pluginVersion)?.pluginVersion || null),
    bundlesInfoPath: primary.bundlesInfoPath,
    workspaces,
  };
}

function httpRequestSimple(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsed,
      { method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            ok: true,
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, code: err.code || 'ERROR', error: String(err.message || err) });
    });
    if (body) req.write(body);
    req.end();
  });
}

function parseMcpHttpBody(body, contentType = '') {
  if (String(contentType).startsWith('text/event-stream')) {
    const dataLines = [];
    for (const line of String(body).split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) {
      return JSON.parse(dataLines.join('\n'));
    }
  }
  return JSON.parse(body);
}

async function probeEdtMcpPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  const baseUrl = `http://${host}:${port}`;
  const health = await httpRequestSimple(`${baseUrl}/health`, { timeoutMs });
  if (!health.ok) {
    return {
      port,
      state: 'closed',
      endpoint: `${baseUrl}/mcp`,
      detail: health.code || health.error,
    };
  }

  let healthJson = null;
  try {
    healthJson = JSON.parse(health.body);
  } catch {
    healthJson = null;
  }

  const initPayload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: '1c-ai-pipeline-doctor', version: '1.1.0' },
    },
  });

  const mcpResp = await httpRequestSimple(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: initPayload,
    timeoutMs,
  });

  if (mcpResp.ok && mcpResp.statusCode === 200) {
    try {
      const parsed = parseMcpHttpBody(mcpResp.body, mcpResp.headers['content-type']);
      const serverName = parsed?.result?.serverInfo?.name || '';
      if (parsed?.result && (serverName.toLowerCase().includes('edt') || healthJson?.edtVersion !== undefined)) {
        const sessionId = mcpResp.headers['mcp-session-id'];
        let projects = null;
        if (sessionId) {
          await httpRequestSimple(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2025-06-18',
              'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            timeoutMs,
          });
          const listResp = await httpRequestSimple(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'MCP-Protocol-Version': '2025-06-18',
              'Mcp-Session-Id': sessionId,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: 'list_projects', arguments: {} },
            }),
            timeoutMs: 3000,
          });
          if (listResp.ok && listResp.statusCode === 200) {
            try {
              const listJson = parseMcpHttpBody(listResp.body, listResp.headers['content-type']);
              projects = listJson?.result?.structuredContent || listJson?.result?.content || null;
            } catch {
              projects = null;
            }
          }
        }
        return {
          port,
          state: 'edt_mcp_ready',
          endpoint: `${baseUrl}/mcp`,
          edtVersion: healthJson?.edtVersion || null,
          serverInfo: parsed.result.serverInfo || null,
          projects,
        };
      }
    } catch {
      // Fall through to foreign service
    }
  }

  return {
    port,
    state: 'foreign_service',
    endpoint: `${baseUrl}/mcp`,
    httpStatus: mcpResp.ok ? mcpResp.statusCode : health.statusCode,
    detail: `Порт ${port} занят посторонним процессом (ответ HTTP ${mcpResp.ok ? mcpResp.statusCode : health.statusCode}, это не EDT MCP).`,
  };
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

async function findFreeLocalPort(startPort = 8766, endPort = 8779) {
  for (let p = startPort; p <= endPort; p += 1) {
    if (await isPortFree(p)) return p;
  }
  return startPort;
}

async function diagnoseEdtSubsystem(edtInfo, settingsData = {}, options = {}) {
  const configuredUrl = settingsData.edt_mcp_url || null;
  let configuredPort = null;
  if (configuredUrl) {
    try {
      configuredPort = Number(new URL(configuredUrl).port) || null;
    } catch {
      configuredPort = null;
    }
  }
  const wsPorts = (edtInfo.workspaces || []).map((w) => w.port).filter(Boolean);
  const candidatePorts = [...new Set([configuredPort, ...wsPorts, 8765, 8766].filter(Boolean))];
  const probeFn = options.probePortFn || probeEdtMcpPort;

  const probes = [];
  for (const port of candidatePorts) {
    const res = await probeFn(port);
    probes.push(res);
    if (res.state === 'edt_mcp_ready') {
      return {
        status: 'ready',
        endpoint: res.endpoint,
        port: res.port,
        edtVersion: res.edtVersion,
        projects: res.projects,
        edt: edtInfo,
        probes,
      };
    }
  }

  const defaultProbe = probes.find((p) => p.port === (configuredPort || 8765)) || probes[0];
  const port8765Conflict = probes.find((p) => p.port === 8765 && p.state === 'foreign_service');
  const suggestedPort = port8765Conflict
    ? (options.findFreePortFn ? await options.findFreePortFn(8766) : await findFreeLocalPort(8766))
    : (configuredPort || wsPorts[0] || 8765);

  if (!edtInfo.installed) {
    if (edtInfo.unsupportedOnly) {
      return {
        status: 'edt_version_unsupported',
        unsupportedVersions: edtInfo.unsupportedVersions || [],
        detail: `Найдена устаревшая версия 1С:EDT (${(edtInfo.unsupportedVersions || []).join(', ')}), а плагин EDT MCP поддерживает линейки 2025.2, 2026.1 и 2026.2. Откройте установщик 1C:EDT Start и установите актуальную версию 2026.1 или 2026.2.`,
        port8765Conflict: Boolean(port8765Conflict),
        portConflictDetail: port8765Conflict ? port8765Conflict.detail : null,
        suggestedPort,
        edt: edtInfo,
        officialDownload: OFFICIAL_EDT_DOWNLOAD,
        probes,
      };
    }
    return {
      status: 'edt_not_installed',
      port8765Conflict: Boolean(port8765Conflict),
      portConflictDetail: port8765Conflict ? port8765Conflict.detail : null,
      suggestedPort,
      edt: edtInfo,
      officialDownload: OFFICIAL_EDT_DOWNLOAD,
      probes,
    };
  }

  if (!edtInfo.pluginInstalled || edtInfo.allSupportedHavePlugin === false) {
    return {
      status: 'plugin_not_installed',
      partiallyInstalled: Boolean(edtInfo.pluginInstalled && edtInfo.allSupportedHavePlugin === false),
      port8765Conflict: Boolean(port8765Conflict),
      portConflictDetail: port8765Conflict ? port8765Conflict.detail : null,
      suggestedPort,
      edt: edtInfo,
      probes,
    };
  }

  if (defaultProbe && defaultProbe.state === 'foreign_service') {
    return {
      status: 'port_conflict',
      portConflictDetail: defaultProbe.detail,
      suggestedPort,
      edt: edtInfo,
      probes,
    };
  }

  return {
    status: 'edt_not_running',
    endpoint: `http://127.0.0.1:${suggestedPort}/mcp`,
    suggestedPort,
    edt: edtInfo,
    probes,
  };
}

function probeVanessaRunnerMcpTools(oscript, runnerRoot, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const entry = path.join(runnerRoot, 'src', 'mcp.os');
    const child = spawn(oscript, [entry], {
      cwd: runnerRoot,
      env: buildChildEnv(process.env, process.platform),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutBuf = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // Ignore
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, detail: 'timeout waiting for vanessa-runner MCP tools/list' });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, detail: String(err.message || err) });
    });

    let sentList = false;
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === 1 && !sentList) {
            sentList = true;
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          } else if (msg.id === 2) {
            clearTimeout(timer);
            const tools = msg?.result?.tools || [];
            finish({ ok: true, toolCount: tools.length });
          }
        } catch {
          // Ignore non-JSON banner lines
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: '1c-ai-pipeline-doctor', version: '1.1.0' },
        },
      }) + '\n'
    );
  });
}

function inspectVanessaAutomation(settingsData = {}, options = {}) {
  const homedir = options.homedir !== undefined ? options.homedir : os.homedir();
  const repoRoot = findRepoCloneRoot(options);
  const candidates = [
    settingsData.automation_root,
    repoRoot ? path.join(repoRoot, 'vanessa-automation') : null,
    homedir ? path.join(homedir, 'tools', 'vanessa-ai-pipeline', 'vanessa-automation') : null,
    homedir ? path.join(homedir, 'vanessa-automation') : null,
  ].filter(Boolean);

  let root = null;
  for (const cand of candidates) {
    const resolved = path.resolve(cand);
    if (isDir(resolved) && isDir(path.join(resolved, 'features', 'Libraries'))) {
      root = resolved;
      break;
    }
  }
  if (!root) {
    return { cloned: false, ready: false, root: null, epfPath: null };
  }
  const epfCandidates = [
    settingsData.epf_path,
    path.join(root, 'vanessa-automation.epf'),
    path.join(root, 'vanessa-automation-single.epf'),
    path.join(root, 'build', 'vanessa-automation.epf'),
  ].filter(Boolean);
  const epfPath = epfCandidates.find(isFile) || null;
  return {
    cloned: true,
    ready: Boolean(epfPath),
    root,
    epfPath,
    librariesReady: isDir(path.join(root, 'features', 'Libraries')),
  };
}

async function runDoctor(options = {}) {
  const nodePath = inspectNodeAndPath(options);
  const gitIdentity = inspectGitIdentity(options);
  const aiClients = discoverAiClients(options);
  const platforms = discoverPlatforms(options);
  const runnerDiag = diagnoseRunnerLauncher(options.settingsPath || null, options);
  const runnerLauncherReady = runnerDiag.checks.every((c) => c.ok);

  let runnerMcpProbe = null;
  if (runnerLauncherReady && options.probeMcp !== false) {
    runnerMcpProbe = await probeVanessaRunnerMcpTools(runnerDiag.oscript, runnerDiag.runnerRoot);
  }

  const settingsData = runnerDiag.settingsInfo?.data || {};
  const vanessaAutomation = inspectVanessaAutomation(settingsData, options);
  const edtInfo = discoverEdtInstallation(options);
  const edtSubsystem = await diagnoseEdtSubsystem(edtInfo, settingsData, options);

  const canWorkWithoutEdtNow = Boolean(platforms.length > 0 && runnerLauncherReady);
  const canWorkWithEdtNow = edtSubsystem.status === 'ready';

  return {
    nodePath,
    gitIdentity,
    aiClients,
    platforms,
    selectedPlatform: settingsData.v8version || (platforms[0] ? platforms[0].version : null),
    vanessaRunner: {
      ready: runnerLauncherReady && (runnerMcpProbe ? runnerMcpProbe.ok : true),
      oscript: runnerDiag.oscript,
      runnerRoot: runnerDiag.runnerRoot,
      checks: runnerDiag.checks,
      mcpToolsCount: runnerMcpProbe?.ok ? runnerMcpProbe.toolCount : null,
      mcpProbeError: runnerMcpProbe && !runnerMcpProbe.ok ? runnerMcpProbe.detail : null,
    },
    vanessaAutomation,
    edt: edtSubsystem,
    humanChecklist: {
      gitAuthorConfigured: gitIdentity.configured,
      edtInstalled: Boolean(edtInfo.installed),
      releaseEngineerRepoHintRu:
        'Попросите у релиз-инженера доступ к репозиторию конфигурации 1С (КА / ЗУП / вашей базы) на вашу корпоративную почту и пришлите полученную ссылку в чат — ИИ сам скачает проект.',
      manualTestDbLicenseHintRu:
        'Откройте локальную тестовую копию базы (не боевую!) 1 раз вручную в «1С:Предприятии» и убедитесь, что она запускается без окна лицензии (при необходимости активируйте корп. пин-код или бесплатную комьюнити-лицензию с https://developer.1c.ru/).',
    },
    onboardingModes: {
      directDatabaseModeReady: canWorkWithoutEdtNow,
      edtModeReady: canWorkWithEdtNow,
    },
    settingsFile: runnerDiag.settingsInfo?.source || defaultSettingsPath(options.env, options.platform, options.homedir),
  };
}

function isEdtProcessRunning(edtExecutable, platform = process.platform) {
  if (!edtExecutable) return false;
  if (platform === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process -Name '1cedt' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    const lines = (ps.stdout || '').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    return lines.includes(path.resolve(edtExecutable).toLowerCase());
  }
  const pgrep = spawnSync('pgrep', ['-f', edtExecutable], { encoding: 'utf8', timeout: 3000 });
  return pgrep.status === 0 && Boolean((pgrep.stdout || '').trim());
}

function httpsGetFollowRedirects(urlString, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const visit = (targetUrl, remaining) => {
      if (remaining < 0) {
        reject(new Error('Too many redirects'));
        return;
      }
      const req = https.get(
        targetUrl,
        { headers: { 'User-Agent': '1c-ai-pipeline-deploy/1.1.0', Accept: 'application/vnd.github+json' }, timeout: 30000 },
        (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            visit(new URL(res.headers.location, targetUrl).toString(), remaining - 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    };
    visit(urlString, maxRedirects);
  });
}

function extractZipArchive(zipFile, destDir, platform = process.platform) {
  fs.mkdirSync(destDir, { recursive: true });
  if (platform === 'win32') {
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:PIPELINE_ZIP -DestinationPath $env:PIPELINE_DEST -Force',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
        env: { ...process.env, PIPELINE_ZIP: zipFile, PIPELINE_DEST: destDir },
      }
    );
    return res.status === 0;
  }
  const unzip = spawnSync('unzip', ['-oq', zipFile, '-d', destDir], { encoding: 'utf8', timeout: 60000 });
  if (unzip.status === 0) return true;
  const tar = spawnSync('tar', ['-xf', zipFile, '-C', destDir], { encoding: 'utf8', timeout: 60000 });
  return tar.status === 0;
}

function hasEdtMcpSourcesChangedSinceBuild(edtMcpDir, contentJarPath) {
  if (!isFile(contentJarPath)) return true;
  let buildMtimeMs = 0;
  try {
    buildMtimeMs = fs.statSync(contentJarPath).mtimeMs;
  } catch {
    return true;
  }

  // 1. Any modified/untracked source file in working tree newer than content.jar triggers rebuild
  const statusRes = spawnSync('git', ['-C', edtMcpDir, 'status', '--porcelain'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (statusRes.status === 0 && statusRes.stdout.trim()) {
    for (const rawLine of statusRes.stdout.split(/\r?\n/)) {
      if (!rawLine || rawLine.length < 4) continue;
      const rel = rawLine.slice(3).trim().replace(/^"|"$/g, '');
      const full = path.join(edtMcpDir, rel);
      try {
        if (fs.existsSync(full) && fs.statSync(full).mtimeMs > buildMtimeMs) {
          return true;
        }
      } catch {
        return true;
      }
    }
  }

  // 2. If HEAD commit timestamp is newer than content.jar, rebuild
  const logRes = spawnSync('git', ['-C', edtMcpDir, 'log', '-1', '--format=%ct'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (logRes.status === 0 && logRes.stdout.trim()) {
    const headEpochMs = Number(logRes.stdout.trim()) * 1000;
    if (Number.isFinite(headEpochMs) && headEpochMs > buildMtimeMs) {
      return true;
    }
  }
  return false;
}

async function downloadReleaseEdtP2(options = {}) {
  const metaRaw = await httpsGetFollowRedirects(EDT_RELEASE_API_URL);
  const release = JSON.parse(metaRaw.toString('utf8'));
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const zipAsset = assets.find((a) => /^MCP-EDT\.v.*\.zip$/i.test(a.name));
  const shaAsset = assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!zipAsset || !zipAsset.browser_download_url) {
    return {
      ok: false,
      reason: 'release_asset_missing',
      detail: 'В GitHub Releases пока нет опубликованного архива MCP-EDT.v*.zip.',
    };
  }
  const cacheBase = path.join(
    path.dirname(defaultSettingsPath(options.env, options.platform, options.homedir)),
    'edt-mcp-p2',
    release.tag_name || 'latest'
  );
  const unpackedDir = path.join(cacheBase, 'repository');
  if (
    isDir(unpackedDir) &&
    (isFile(path.join(unpackedDir, 'content.jar')) || isFile(path.join(unpackedDir, 'content.xml.xz')))
  ) {
    return { ok: true, source: 'release-cache', path: unpackedDir, tag: release.tag_name };
  }
  fs.mkdirSync(cacheBase, { recursive: true });
  const zipPath = path.join(cacheBase, zipAsset.name);
  const zipBytes = await httpsGetFollowRedirects(zipAsset.browser_download_url);
  if (shaAsset && shaAsset.browser_download_url) {
    const shaText = (await httpsGetFollowRedirects(shaAsset.browser_download_url)).toString('utf8');
    const expectedLine = shaText.split(/\r?\n/).find((l) => l.includes(zipAsset.name));
    if (expectedLine) {
      const expectedHash = expectedLine.trim().split(/\s+/)[0].toLowerCase();
      const actualHash = crypto.createHash('sha256').update(zipBytes).digest('hex').toLowerCase();
      if (expectedHash !== actualHash) {
        return { ok: false, reason: 'sha256_mismatch', detail: `SHA-256 mismatch for ${zipAsset.name}` };
      }
    }
  }
  fs.writeFileSync(zipPath, zipBytes);
  if (extractZipArchive(zipPath, unpackedDir, options.platform || process.platform)) {
    return { ok: true, source: 'github-release-fallback', path: unpackedDir, tag: release.tag_name };
  }
  return { ok: false, reason: 'zip_extract_failed', detail: `Не удалось распаковать ${zipPath}` };
}

async function resolveEdtP2Repository(options = {}) {
  if (options.p2Dir && isDir(options.p2Dir)) {
    return { ok: true, source: 'explicit', path: path.resolve(options.p2Dir) };
  }

  // Extreme fallback ONLY when explicitly requested via --from-release
  if (options.fromRelease) {
    try {
      return await downloadReleaseEdtP2(options);
    } catch (error) {
      return {
        ok: false,
        reason: 'release_download_failed',
        detail: `Не удалось скачать резервный релиз из GitHub Releases: ${error.message || error}`,
      };
    }
  }

  // Primary path: build directly from the local editable fork ./edt-mcp via mise
  const repoRoot = findRepoCloneRoot(options);
  const edtMcpDir = options.edtMcpDir || (repoRoot ? path.join(repoRoot, 'edt-mcp') : null);
  if (!edtMcpDir || !isDir(edtMcpDir)) {
    return {
      ok: false,
      reason: 'edt_mcp_clone_missing',
      detail:
        'Локальный клон ./edt-mcp не найден. Выполните `pipeline-deploy.cjs deploy` (или `mise run forks:clone`), чтобы работать с живыми исходниками форка. Флаг --from-release используйте только как крайний резервный вариант, если сборка на ПК невозможна.',
    };
  }

  const localBuilt = path.join(
    edtMcpDir,
    'mcp',
    'repositories',
    'com.ditrix.edt.mcp.server.repository',
    'target',
    'repository'
  );
  const contentJar = path.join(localBuilt, 'content.jar');
  const needsBuild =
    Boolean(options.rebuild) ||
    !isDir(localBuilt) ||
    hasEdtMcpSourcesChangedSinceBuild(edtMcpDir, contentJar);

  if (!needsBuild) {
    return { ok: true, source: 'local-source-up-to-date', path: localBuilt };
  }

  const buildRunner = options.runSourceBuildFn || ((dir) => {
    const miseBin = resolveMiseBinary(options);
    if (!miseBin) {
      return {
        ok: false,
        detail: 'Не найден mise для локальной сборки ./edt-mcp (JDK 25 + Maven 3.9). Установите mise.',
      };
    }
    const echoOut = (res) => {
      if (options.quietBuild) return;
      if (res && res.stdout) process.stdout.write(res.stdout);
      if (res && res.stderr) process.stderr.write(res.stderr);
    };
    spawnSync(miseBin, ['trust'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    const installRes = spawnSync(miseBin, ['install'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 600000,
    });
    echoOut(installRes);
    if (installRes.status !== 0) {
      const combinedInstall = `${installRes.stdout || ''}\n${installRes.stderr || ''}`;
      if (isSandboxLoopbackError(combinedInstall)) {
        return { ok: false, reason: 'sandbox_loopback_blocked', detail: combinedInstall.trim() };
      }
      return { ok: false, detail: `mise install в ${dir} завершился с кодом ${installRes.status}` };
    }
    const buildRes = spawnSync(miseBin, ['run', 'build'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 900000,
    });
    echoOut(buildRes);
    if (buildRes.status !== 0) {
      const combinedBuild = `${buildRes.stdout || ''}\n${buildRes.stderr || ''}`;
      if (isSandboxLoopbackError(combinedBuild)) {
        return { ok: false, reason: 'sandbox_loopback_blocked', detail: combinedBuild.trim() };
      }
      return { ok: false, detail: `mise run build в ${dir} завершился с кодом ${buildRes.status}` };
    }
    return { ok: true };
  });

  const buildOutcome = buildRunner(edtMcpDir);
  if (buildOutcome.ok && isDir(localBuilt)) {
    return { ok: true, source: 'built-from-local-source', path: localBuilt };
  }

  if (buildOutcome.reason === 'sandbox_loopback_blocked' || isSandboxLoopbackError(buildOutcome.detail)) {
    return {
      ok: false,
      reason: 'sandbox_loopback_blocked',
      detail:
        'Песочница клиента ИИ на Windows заблокировала локальные loopback-сокеты Java (Unable to establish loopback connection). ' +
        'Перезапустите команду вне песочницы (с повышенными разрешениями в клиенте ИИ).',
    };
  }

  return {
    ok: false,
    reason: 'local_source_build_failed',
    detail:
      `${buildOutcome.detail || 'Сборка локального форка ./edt-mcp не удалась.'} ` +
      'Разберите ошибку сборки в ./edt-mcp (это штатный путь, позволяющий агенту патчить EDT MCP под задачи). ' +
      'Только если на этом ПК корпоративная сеть полностью блокирует Maven, используйте крайний резервный флаг --from-release.',
  };
}

function writeEdtWorkspacePortPrefs(workspaceDir, port) {
  if (!workspaceDir || !isDir(workspaceDir)) return null;
  const prefsFile = path.join(
    workspaceDir,
    '.metadata',
    '.plugins',
    'org.eclipse.core.runtime',
    '.settings',
    'com.ditrix.edt.mcp.server.prefs'
  );
  let lines = ['eclipse.preferences.version=1'];
  if (isFile(prefsFile)) {
    lines = fs
      .readFileSync(prefsFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('port=') && !l.startsWith('autoStart='));
  }
  lines.push(`port=${port}`);
  lines.push('autoStart=true');
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  fs.writeFileSync(prefsFile, lines.join('\n') + '\n', 'utf8');
  return prefsFile;
}

async function deployEdtPlugin(options = {}) {
  const edtInfo = discoverEdtInstallation(options);
  if (!edtInfo.installed) {
    if (edtInfo.unsupportedOnly) {
      return {
        ok: false,
        status: 'edt_version_unsupported',
        unsupportedVersions: edtInfo.unsupportedVersions || [],
        officialDownload: OFFICIAL_EDT_DOWNLOAD,
        detail:
          `Найдена устаревшая версия 1С:EDT (${(edtInfo.unsupportedVersions || []).join(', ')}), а плагин EDT MCP поддерживает версии 2025.2, 2026.1 и 2026.2. ` +
          'Откройте 1C:EDT Start и установите актуальную версию 2026.1 или 2026.2.',
      };
    }
    return {
      ok: false,
      status: 'edt_not_installed',
      officialDownload: OFFICIAL_EDT_DOWNLOAD,
    };
  }

  const targets =
    Array.isArray(edtInfo.supportedInstallations) && edtInfo.supportedInstallations.length > 0
      ? edtInfo.supportedInstallations
      : [
          {
            executable: edtInfo.executable,
            version: edtInfo.version || null,
            javaExecutable: edtInfo.javaExecutable,
            pluginInstalled: edtInfo.pluginInstalled,
          },
        ];

  const targetsWithJava = targets.filter((t) => Boolean(t.javaExecutable));
  if (targetsWithJava.length === 0) {
    return {
      ok: false,
      status: 'edt_java_missing',
      detail: `Найдена 1С:EDT (${edtInfo.executable}), но не удалось определить её комплектную JVM из 1cedt.ini. Задайте переменную EDT_JAVA.`,
    };
  }

  const p2 = await resolveEdtP2Repository(options);
  if (!p2.ok) {
    return { ok: false, status: p2.reason, detail: p2.detail, edt: edtInfo };
  }

  const isRunningCheck =
    options.isEdtRunningFn ||
    ((exe) => isEdtProcessRunning(exe, options.platform || process.platform));
  const directorRunner =
    options.runDirectorFn ||
    ((exe, args) =>
      spawnSync(exe, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 180000,
      }));

  const repoUri = 'file:///' + p2.path.replace(/\\/g, '/').replace(/^\/+/, '');
  const installedTargets = [];
  const skippedRunning = [];
  const failedTargets = [];

  for (const target of targetsWithJava) {
    if (isRunningCheck(target.executable)) {
      skippedRunning.push(target.executable);
      continue;
    }
    const directorArgs = [];
    if (target.javaExecutable) {
      directorArgs.push('-vm', target.javaExecutable);
    }
    directorArgs.push(
      '-nosplash',
      '-application',
      'org.eclipse.equinox.p2.director',
      '-repository',
      repoUri
    );
    if (target.pluginInstalled) {
      directorArgs.push('-uninstallIU', EDT_FEATURE_ID);
    }
    directorArgs.push('-installIU', EDT_FEATURE_ID, '-profileProperties', 'org.eclipse.update.reconcile=true');

    const res = directorRunner(target.executable, directorArgs);
    if (res.status === 0) {
      installedTargets.push({ executable: target.executable, version: target.version || null });
    } else {
      const combinedOut = `${res.stderr || ''}\n${res.stdout || ''}`.trim();
      if (isSandboxLoopbackError(combinedOut)) {
        return {
          ok: false,
          status: 'sandbox_loopback_blocked',
          p2RepositoryPath: p2.path,
          detail:
            'Песочница клиента ИИ на Windows заблокировала локальные loopback-сокеты Java при вызове p2.director (Unable to establish loopback connection). ' +
            'Перезапустите deploy-edt вне песочницы (с повышенными разрешениями).',
        };
      }
      failedTargets.push({
        executable: target.executable,
        version: target.version || null,
        exitCode: res.status,
        detail: combinedOut || `p2.director exited with ${res.status}`,
      });
    }
  }

  if (installedTargets.length === 0) {
    if (skippedRunning.length > 0 && failedTargets.length === 0) {
      return {
        ok: false,
        status: 'edt_running_close_required',
        p2RepositoryPath: p2.path,
        runningExecutables: skippedRunning,
        detail: `Окно 1С:EDT сейчас открыто (${skippedRunning.join(', ')}). Чтобы не повредить профиль Eclipse, закройте 1С:EDT и повторите deploy-edt, либо в открытой 1С:EDT выберите «Справка → Установить новое ПО → Добавить → Локальный» и укажите папку: ${p2.path}`,
      };
    }
    const firstFail = failedTargets[0] || { exitCode: 1, detail: 'p2.director failed' };
    return {
      ok: false,
      status: 'p2_director_failed',
      exitCode: firstFail.exitCode,
      p2RepositoryPath: p2.path,
      failedTargets,
      detail: firstFail.detail,
    };
  }

  // Choose clean port (avoiding occupied 8765 if foreign process holds it)
  let targetPort = options.port ? Number(options.port) : 8765;
  if (!options.port) {
    const probeFn = options.probePortFn || probeEdtMcpPort;
    const freeFn = options.findFreePortFn || findFreeLocalPort;
    const p8765 = await probeFn(8765);
    if (p8765.state === 'foreign_service') {
      targetPort = await freeFn(8766);
    }
  }

  const updatedWorkspaces = [];
  for (const ws of edtInfo.workspaces || []) {
    if (ws.workspace) {
      const written = writeEdtWorkspacePortPrefs(ws.workspace, targetPort);
      if (written) updatedWorkspaces.push(written);
    }
  }

  const primaryInstalledExe = installedTargets[0].executable || edtInfo.executable;
  const endpoint = `http://127.0.0.1:${targetPort}/mcp`;
  writeMergedSettings(
    { edt_executable: primaryInstalledExe, edt_mcp_url: endpoint },
    options.settingsPath || null,
    options
  );

  return {
    ok: true,
    status: 'installed',
    p2Source: p2.source,
    p2RepositoryPath: p2.path,
    edtExecutable: primaryInstalledExe,
    installedTargets,
    skippedRunning,
    failedTargets,
    endpoint,
    port: targetPort,
    updatedWorkspaces,
  };
}

async function runDeploy(options = {}) {
  const steps = [];
  const repoRoot = findRepoCloneRoot(options);
  const platform = options.platform || process.platform;
  const miseBin = resolveMiseBinary(options);
  const gitEnsure = ensureGitOnWindows(options);
  if (platform === 'win32' || gitEnsure.status !== 'already_present') {
    steps.push({ step: 'windows_git', ...gitEnsure });
  }
  const gitBin = gitEnsure.executable || resolveGitBinary(options) || 'git';

  // 1. Optional Windows User Path fix when global node is broken/missing
  const nodeStateBefore = inspectNodeAndPath(options);
  if (!nodeStateBefore.pathNodeHealthy && platform === 'win32' && options.fixUserPath && nodeStateBefore.miseShimsDir) {
    const pathFix = fixWindowsUserPathForMise(nodeStateBefore.miseShimsDir, options);
    steps.push({ step: 'windows_user_path', ...pathFix });
  }

  // 2. Clone missing public forks if running inside vanessa-ai-pipeline checkout
  if (repoRoot) {
    for (const fork of FORK_REPOS) {
      const targetDir = path.join(repoRoot, fork.dir);
      if (isDir(path.join(targetDir, '.git'))) {
        steps.push({ step: `clone:${fork.dir}`, status: 'already_present', path: targetDir });
        continue;
      }
      const cl = spawnSync(gitBin, ['clone', fork.origin, targetDir], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 300000,
      });
      if (cl.status === 0) {
        spawnSync(gitBin, ['-C', targetDir, 'remote', 'add', 'upstream', fork.upstream], {
          encoding: 'utf8',
          windowsHide: true,
        });
        steps.push({ step: `clone:${fork.dir}`, status: 'cloned', path: targetDir });
      } else {
        steps.push({
          step: `clone:${fork.dir}`,
          status: 'failed',
          detail: (cl.stderr || cl.stdout || '').trim(),
        });
      }
    }
  }

  // 3. Provision vanessa-runner dependencies
  const runnerRoot = repoRoot
    ? path.join(repoRoot, 'vanessa-runner')
    : resolveRunnerRoot(null, options);

  if (runnerRoot && isDir(runnerRoot)) {
    if (!hasRunnerDependencies(runnerRoot)) {
      if (platform === 'win32' && miseBin) {
        spawnSync(miseBin, ['trust'], { cwd: runnerRoot, windowsHide: true });
        spawnSync(miseBin, ['install'], { cwd: runnerRoot, stdio: 'inherit', windowsHide: true, timeout: 300000 });
        const sr = spawnSync(miseBin, ['run', 'setup'], {
          cwd: runnerRoot,
          stdio: 'inherit',
          windowsHide: true,
          timeout: 300000,
        });
        steps.push({ step: 'vanessa_runner_setup', status: sr.status === 0 ? 'completed' : 'failed' });
      } else {
        const oscript = resolveOscript(null, options);
        const opmNames = platform === 'win32' ? ['opm.bat', 'opm.cmd', 'opm.exe'] : ['opm'];
        const opm = oscript
          ? opmNames.map((n) => path.join(path.dirname(oscript), n)).find(isFile) || findInPath(opmNames, options.env, platform)
          : null;
        if (opm) {
          const shellNeeded = platform === 'win32';
          spawnSync(opm, ['install', '--local', '--dev'], { cwd: runnerRoot, shell: shellNeeded, stdio: 'inherit', timeout: 300000 });
          spawnSync(opm, ['install', '--local', 'autumn-logos@1.3.3'], { cwd: runnerRoot, shell: shellNeeded, stdio: 'inherit', timeout: 120000 });
          const checkPatch = spawnSync(gitBin, ['apply', '--ignore-space-change', '--reverse', '--check', 'patches/autumn-mcp-discovery.patch'], { cwd: runnerRoot });
          if (checkPatch.status !== 0) {
            spawnSync(gitBin, ['apply', '--ignore-space-change', 'patches/autumn-mcp-discovery.patch'], { cwd: runnerRoot });
          }
          steps.push({ step: 'vanessa_runner_setup', status: hasRunnerDependencies(runnerRoot) ? 'completed' : 'partial' });
        } else {
          steps.push({ step: 'vanessa_runner_setup', status: 'skipped_no_oscript_or_mise' });
        }
      }
    } else {
      steps.push({ step: 'vanessa_runner_setup', status: 'already_ready' });
    }
  }

  // 4. Persist discovered paths to settings.json
  const oscriptResolved = resolveOscript(null, options);
  const runnerResolved = resolveRunnerRoot(runnerRoot, options);
  const platforms = discoverPlatforms(options);
  const vaInfo = inspectVanessaAutomation({}, { ...options, repoRoot });
  const edtInfo = discoverEdtInstallation(options);

  let edtDeployResult = null;
  if (!options.skipEdt && edtInfo.installed && (!edtInfo.pluginInstalled || edtInfo.allSupportedHavePlugin === false)) {
    edtDeployResult = await deployEdtPlugin({ ...options, repoRoot });
    steps.push({ step: 'edt_mcp_deploy', ...edtDeployResult });
  } else if (options.openEdtDownload && !edtInfo.installed && !edtInfo.unsupportedOnly) {
    const browserRes = openUrlInSystemBrowser('edt', options);
    steps.push({ step: 'open_edt_download_browser', ...browserRes });
  }

  const edtAfter = await diagnoseEdtSubsystem(discoverEdtInstallation(options), {}, options);
  const edtEndpoint = edtAfter.endpoint || `http://127.0.0.1:${edtAfter.suggestedPort || 8765}/mcp`;

  const savedSettings = writeMergedSettings(
    {
      oscript: oscriptResolved,
      runner_root: runnerResolved,
      automation_root: vaInfo.root,
      epf_path: vaInfo.epfPath,
      v8version: platforms[0] ? platforms[0].version : null,
      edt_executable: edtInfo.executable,
      edt_mcp_url: edtEndpoint,
    },
    options.settingsPath || null,
    options
  );
  steps.push({ step: 'settings_json', status: 'saved', path: savedSettings.path });

  const doctor = await runDoctor(options);
  return { steps, doctor };
}

function formatHumanDoctorReport(report) {
  const lines = [];
  lines.push('=== Состояние окружения 1c-ai-pipeline ===');
  lines.push(
    `1. Node.js в PATH: ${
      report.nodePath.pathNodeHealthy
        ? `OK (${report.nodePath.pathNodeVersion} -> ${report.nodePath.firstNodeInPath})`
        : `ТРЕБУЕТ ВНИМАНИЯ (${report.nodePath.pathNodeError}; текущий процесс: ${report.nodePath.currentProcessVersion})`
    }`
  );
  lines.push(
    `2. Платформа 1С:Предприятие: ${
      report.platforms.length > 0
        ? report.platforms.map((p) => `${p.version} (${p.clientPath})`).join(', ')
        : 'НЕ НАЙДЕНА в стандартных каталогах'
    }`
  );
  lines.push(
    `3. Vanessa Runner MCP: ${
      report.vanessaRunner.ready
        ? `ГОТОВ (OneScript: ${report.vanessaRunner.oscript}${
            report.vanessaRunner.mcpToolsCount ? `, инструментов MCP: ${report.vanessaRunner.mcpToolsCount}` : ''
          })`
        : `НЕ ГОТОВ (${report.vanessaRunner.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')})`
    }`
  );
  lines.push(
    `4. Vanessa Automation: ${
      report.vanessaAutomation.ready
        ? `ГОТОВА (${report.vanessaAutomation.epfPath})`
        : report.vanessaAutomation.cloned
          ? `Клон найден (${report.vanessaAutomation.root}), сборка .epf ещё не выполнена`
          : 'Клон не найден'
    }`
  );

  const edt = report.edt;
  const supportedList = (edt.edt && Array.isArray(edt.edt.supportedInstallations))
    ? edt.edt.supportedInstallations
    : [];
  const multiEdtNote = supportedList.length > 1
    ? ` [всего поддерживаемых версий EDT на диске: ${supportedList.map((i) => i.version || i.executable).join(', ')}]`
    : '';
  if (edt.status === 'ready') {
    lines.push(`5. 1С:EDT и EDT MCP: ГОТОВ (${edt.endpoint}, EDT ${edt.edtVersion || ''})${multiEdtNote}`);
  } else if (edt.status === 'edt_not_running') {
    lines.push(
      `5. 1С:EDT и EDT MCP: ПЛАГИН УСТАНОВЛЕН в 1С:EDT (${edt.edt.executable})${multiEdtNote}, но окно 1С:EDT сейчас закрыто (ожидаемый адрес: ${edt.endpoint})`
    );
  } else if (edt.status === 'port_conflict') {
    lines.push(
      `5. 1С:EDT и EDT MCP: КОНФЛИКТ ПОРТА — ${edt.portConflictDetail} Рекомендуемый свободный порт: ${edt.suggestedPort}`
    );
  } else if (edt.status === 'plugin_not_installed') {
    lines.push(
      `5. 1С:EDT и EDT MCP: 1С:EDT найдена (${edt.edt.executable})${multiEdtNote}, но плагин EDT MCP установлен не во все найденные версии. Выполните: node .agents/plugins/1c-ai-pipeline/bin/pipeline-deploy.cjs deploy-edt`
    );
  } else if (edt.status === 'edt_version_unsupported') {
    lines.push(
      `5. 1С:EDT и EDT MCP: ТРЕБУЕТСЯ ОБНОВЛЕНИЕ EDT — ${edt.detail}`
    );
  } else {
    lines.push('5. 1С:EDT и EDT MCP: 1С:EDT на этом компьютере НЕ УСТАНОВЛЕНА.');
    if (edt.portConflictDetail) {
      lines.push(`   Примечание по порту 8765: ${edt.portConflictDetail}`);
    }
    lines.push(`   Официальный установщик 1С:EDT (бесплатно): ${OFFICIAL_EDT_DOWNLOAD.landingUrl}`);
    lines.push(`   Раздел на портале релизов 1С: ${OFFICIAL_EDT_DOWNLOAD.releasesUrl}`);
    lines.push(`   Комьюнити-лицензия разработчика 1С: ${OFFICIAL_EDT_DOWNLOAD.communityLicenseUrl}`);
  }

  if (report.gitIdentity) {
    lines.push(
      `6. Автор изменений (Git): ${
        report.gitIdentity.configured
          ? `НАСТРОЕН (${report.gitIdentity.userName} <${report.gitIdentity.userEmail}>)`
          : 'НЕ ЗАПОЛНЕН — спросите у пользователя его Имя, Фамилию и корпоративный e-mail простым языком и выполните setup-git'
      }`
    );
  }
  lines.push(`7. Файл настроек: ${report.settingsFile}`);
  if (report.onboardingModes.directDatabaseModeReady && !report.onboardingModes.edtModeReady) {
    lines.push(
      '-> Статус старта: МОЖНО РАБОТАТЬ ПРЯМО СЕЙЧАС в режиме «Платформа 1С + Vanessa Runner» по тестовой копии базы (КА / ЗУП / ERP) без ожидания установки 1С:EDT.'
    );
  } else if (report.onboardingModes.edtModeReady) {
    lines.push('-> Статус старта: ПОЛНЫЙ СТЕНД ГОТОВ (доступны и 1С:EDT MCP, и Vanessa Runner).');
  }
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const args = [...argv];
  const subcommand = (args[0] && !args[0].startsWith('-')) ? args.shift() : 'doctor';
  const flags = {
    subcommand,
    json: false,
    fixUserPath: false,
    openEdtDownload: false,
    skipEdt: false,
    skipVa: false,
    rebuild: false,
    fromRelease: false,
    probeMcp: true,
    settingsPath: null,
    p2Dir: null,
    edtExe: null,
    port: null,
    repoRoot: null,
    gitName: null,
    gitEmail: null,
    browserTarget: 'edt',
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--fix-user-path') flags.fixUserPath = true;
    else if (arg === '--open-edt-download') flags.openEdtDownload = true;
    else if (arg === '--skip-edt') flags.skipEdt = true;
    else if (arg === '--skip-va') flags.skipVa = true;
    else if (arg === '--rebuild') flags.rebuild = true;
    else if (arg === '--from-release') flags.fromRelease = true;
    else if (arg === '--no-mcp-probe') flags.probeMcp = false;
    else if (arg === '--settings' && args[i + 1]) flags.settingsPath = args[++i];
    else if (arg === '--p2-dir' && args[i + 1]) flags.p2Dir = args[++i];
    else if (arg === '--edt-exe' && args[i + 1]) flags.edtExe = args[++i];
    else if (arg === '--port' && args[i + 1]) flags.port = Number(args[++i]);
    else if (arg === '--repo-root' && args[i + 1]) flags.repoRoot = args[++i];
    else if (arg === '--name' && args[i + 1]) flags.gitName = args[++i];
    else if (arg === '--email' && args[i + 1]) flags.gitEmail = args[++i];
    else if (arg === '--target' && args[i + 1]) flags.browserTarget = args[++i];
    else if (arg === '--license') flags.browserTarget = 'license';
  }
  return flags;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseCliArgs(argv);
  if (flags.subcommand === 'doctor') {
    const report = await runDoctor(flags);
    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(formatHumanDoctorReport(report) + '\n');
    }
    return 0;
  }
  if (flags.subcommand === 'deploy') {
    const result = await runDeploy(flags);
    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(formatHumanDoctorReport(result.doctor) + '\n');
    }
    return 0;
  }
  if (flags.subcommand === 'deploy-edt') {
    const result = await deployEdtPlugin(flags);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 2;
  }
  if (flags.subcommand === 'setup-git') {
    const result = configureGitIdentity(flags.gitName, flags.gitEmail, flags);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 2;
  }
  if (flags.subcommand === 'open-edt-download') {
    const result = openUrlInSystemBrowser(flags.browserTarget, flags);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 2;
  }
  process.stderr.write(
    `Unknown subcommand: ${flags.subcommand}. Expected: doctor | deploy | deploy-edt | setup-git | open-edt-download\n`
  );
  return 1;
}

module.exports = {
  OFFICIAL_EDT_DOWNLOAD,
  ALLOWED_BROWSER_TARGETS,
  defaultSettingsPath,
  writeMergedSettings,
  findRepoCloneRoot,
  resolveMiseBinary,
  getMiseShimsDir,
  inspectNodeAndPath,
  fixWindowsUserPathForMise,
  resolveGitBinary,
  ensureGitOnWindows,
  isSandboxLoopbackError,
  extractEdtVersion,
  isEdtVersionSupported,
  inspectGitIdentity,
  configureGitIdentity,
  openUrlInSystemBrowser,
  discoverAiClients,
  discoverPlatforms,
  parseEdtIniVm,
  inspectEdtBundlesInfo,
  readEdtWorkspacePrefs,
  discoverEdtInstallation,
  probeEdtMcpPort,
  findFreeLocalPort,
  diagnoseEdtSubsystem,
  inspectVanessaAutomation,
  runDoctor,
  hasEdtMcpSourcesChangedSinceBuild,
  resolveEdtP2Repository,
  deployEdtPlugin,
  runDeploy,
  formatHumanDoctorReport,
  parseCliArgs,
  main,
};

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`pipeline-deploy error: ${err.stack || err.message || err}\n`);
      process.exit(1);
    }
  );
}
