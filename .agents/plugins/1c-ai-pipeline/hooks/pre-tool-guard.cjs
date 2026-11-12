#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const WRITE_TOOL_RE = /^(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file|edit_file|replace_file_content|write_to_file)$/i;
const SHELL_TOOL_RE = /^(?:Bash|shell|sh|zsh|powershell|pwsh|cmd|run_command|execute_command|terminal)$/i;
const BINARY_1C_EXT_RE = /\.(?:1cd|dt|cf|cfe|epf|erf)$/i;
const METADATA_XML_RE = /(?:\.(?:mdo|form)|(?:^|[\\/])(?:Form|Configuration|Rights|ConfigDumpInfo)\.xml)$/i;

function allowDecision(format) {
  return format === 'cursor' ? { permission: 'allow' } : {};
}

function denyDecision(reason, format) {
  if (format === 'cursor') {
    return {
      permission: 'deny',
      user_message: reason,
      agent_message: reason,
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function collectTargetPaths(toolInput) {
  const paths = [];
  for (const key of ['file_path', 'target_file', 'TargetFile', 'path', 'notebook_path']) {
    if (typeof toolInput[key] === 'string' && toolInput[key].trim()) {
      paths.push(toolInput[key].trim());
    }
  }
  const patchText = typeof toolInput.patch === 'string'
    ? toolInput.patch
    : (typeof toolInput.input === 'string' ? toolInput.input : '');
  if (patchText) {
    const headerRe = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gm;
    let match;
    while ((match = headerRe.exec(patchText)) !== null) {
      paths.push(match[1].trim());
    }
  }
  return paths;
}

function collectMutationText(toolInput) {
  const chunks = [];
  for (const key of [
    'content',
    'CodeContent',
    'new_string',
    'ReplacementContent',
    'patch',
    'input',
  ]) {
    if (typeof toolInput[key] === 'string') {
      chunks.push(toolInput[key]);
    }
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.new_string === 'string') {
        chunks.push(edit.new_string);
      }
    }
  }
  return chunks.join('\n');
}

function checkFileMutation(targetPaths, payloadText) {
  for (const rawPath of targetPaths) {
    const normalized = rawPath.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);
    const lowerBase = base.toLowerCase();

    if (lowerBase === 'configdumpinfo.xml') {
      return 'Прямая ручная правка ConfigDumpInfo.xml заблокирована: это служебный индекс инкрементальной выгрузки Конфигуратора 1С. Используй частичную загрузку по списку файлов или штатную перевыгрузку.';
    }
    if (lowerBase === 'parentconfigurations.bin') {
      return 'Прямая модификация ParentConfigurations.bin заблокирована: бинарный файл правил поддержки поставщика нельзя изменять текстовыми инструментами.';
    }
    if (lowerBase === 'form.bin' || BINARY_1C_EXT_RE.test(lowerBase)) {
      return `Прямая текстовая запись в бинарный артефакт 1С (${base}) заблокирована во избежание повреждения контейнера.`;
    }
    if (METADATA_XML_RE.test(normalized) && payloadText.includes(ZERO_UUID)) {
      return 'Запись нулевого UUID (00000000-0000-0000-0000-000000000000) в метаданные или формы 1С заблокирована: используй edt-mcp либо сгенерируй корректный UUID v4.';
    }
  }
  return null;
}

function checkShellCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;

  if (/\/ConfigurationRepositoryUnbindCfg\b/i.test(cmd)) {
    return 'Команда /ConfigurationRepositoryUnbindCfg заблокирована: отключение базы от Хранилища конфигурации 1С допускается только вручную пользователем.';
  }

  if (
    /\b(?:taskkill|pkill|killall|Stop-Process)\b/i.test(cmd) &&
    /\b(?:rphost|rmngr|ragent)(?:\.exe)?\b/i.test(cmd)
  ) {
    return 'Принудительное завершение процессов кластера серверов 1С (rphost/rmngr/ragent) заблокировано: это обрывает транзакции всех активных сеансов.';
  }

  if (
    /\b(?:rm|del|erase|Remove-Item)\b/i.test(cmd) &&
    /(?:1Cv8\.1CD|ParentConfigurations\.bin)\b/i.test(cmd)
  ) {
    return 'Удаление файловой базы 1Cv8.1CD или файла поддержки ParentConfigurations.bin через командную строку заблокировано.';
  }

  const targetsServerCluster = /(?:(?:^|\s)\/S\s+|Srvr\s*=|--db-server\b)/i.test(cmd);
  const mutatesInfobase = /(?:\/LoadCfg\b|\/LoadConfigFromFiles\b|\/UpdateDBCfg\b|\/RestoreIB\b|\binfobase\s+config\s+import\b|\bsession\s+terminate\b)/i.test(cmd);
  if (targetsServerCluster && mutatesInfobase && process.env.ONEC_ALLOW_SERVER_MUTATION !== '1') {
    return 'Пакетная модификация или сброс сеансов серверной ИБ (Srvr= / /S) без явного разрешения заблокированы. Используй локальную файловую базу (/F) либо согласуй операцию с пользователем (ONEC_ALLOW_SERVER_MUTATION=1).';
  }

  return null;
}

function handle(input, format = 'standard') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const event = input.hook_event_name ?? input.event;
  if (event && !['PreToolUse', 'preToolUse'].includes(event)) return {};

  const toolName = String(input.tool_name ?? input.tool ?? '');
  const toolInput = (input.tool_input && typeof input.tool_input === 'object')
    ? input.tool_input
    : input;

  const targetPaths = collectTargetPaths(toolInput);
  if (WRITE_TOOL_RE.test(toolName) || targetPaths.length > 0) {
    const payloadText = collectMutationText(toolInput);
    const fileReason = checkFileMutation(targetPaths, payloadText);
    if (fileReason) return denyDecision(fileReason, format);
  }

  const commandStr = typeof toolInput.command === 'string'
    ? toolInput.command
    : (typeof toolInput.CommandLine === 'string' ? toolInput.CommandLine : '');
  if (SHELL_TOOL_RE.test(toolName) || commandStr) {
    const shellReason = checkShellCommand(commandStr);
    if (shellReason) return denyDecision(shellReason, format);
  }

  return allowDecision(format);
}

function runCli(explicitFormat) {
  const detectedFormat = explicitFormat || (process.env.CURSOR_PLUGIN_ROOT ? 'cursor' : 'standard');
  try {
    const raw = fs.readFileSync(0, 'utf8') || '{}';
    const input = JSON.parse(raw);
    process.stdout.write(JSON.stringify(handle(input, detectedFormat)));
  } catch {
    process.stdout.write(JSON.stringify(allowDecision(detectedFormat)));
  }
}

module.exports = { handle, runCli };

if (require.main === module) {
  runCli(process.argv[2]);
}
