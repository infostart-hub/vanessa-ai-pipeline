#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const WRITE_TOOL_RE = /^(?:Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file|edit_file|replace_file_content|write_to_file)$/i;
const INSPECTED_EXT_RE = /\.(?:bsl|os|mdo|form|xml|feature)$/i;
const MAX_INSPECT_BYTES = 5 * 1024 * 1024;

function hasEdtProjectAncestor(filePath) {
  let current = path.dirname(filePath);
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      if (fs.statSync(path.join(current, '.project')).isFile()) {
        return true;
      }
    } catch {
      // continue walking up
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function inspectModifiedFile(resolvedPath, toolName) {
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INSPECT_BYTES) {
    return [];
  }

  let buf;
  try {
    buf = fs.readFileSync(resolvedPath);
  } catch {
    return [];
  }

  const warnings = [];
  const normalized = resolvedPath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();

  if (buf.includes(0x00)) {
    warnings.push(
      `В файле ${path.basename(resolvedPath)} обнаружены NUL-байты (0x00) — проверь кодировку сохранения UTF-8.`
    );
  }

  const text = buf.toString('utf8');
  if (text.includes('\uFFFD')) {
    warnings.push(
      `В файле ${path.basename(resolvedPath)} обнаружен символ замены U+FFFD — вероятна порча кириллицы при перекодировке.`
    );
  }

  const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (lower.endsWith('.bsl') && lower.includes('/ext/') && !hasUtf8Bom) {
    warnings.push(
      `Модуль выгрузки Конфигуратора (${path.basename(resolvedPath)} в каталоге Ext/) сохранён без маркера UTF-8 BOM (EF BB BF). При загрузке в ИБ кириллица может исказиться.`
    );
  }

  if (/\.(?:mdo|form|xml)$/i.test(lower) && text.includes(ZERO_UUID)) {
    warnings.push(
      `В файле ${path.basename(resolvedPath)} присутствует нулевой UUID (${ZERO_UUID}). Платформа 1С отклонит такую выгрузку.`
    );
  }

  const isRawFileTool = !toolName || (WRITE_TOOL_RE.test(toolName) && !toolName.startsWith('mcp__'));
  if (/\.(?:mdo|form)$/i.test(lower) && isRawFileTool && hasEdtProjectAncestor(resolvedPath)) {
    warnings.push(
      `Файл модели 1С:EDT (${path.basename(resolvedPath)}) изменён напрямую на диске в обход edt-mcp. Обязательно обнови модель проекта и выполни проверку через edt-mcp (get_project_errors).`
    );
  }

  return warnings;
}

function handle(input, format = 'standard') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const event = input.hook_event_name ?? input.event;
  if (event && !['PostToolUse', 'postToolUse'].includes(event)) return {};

  const toolName = String(input.tool_name ?? input.tool ?? '');
  const toolInput = (input.tool_input && typeof input.tool_input === 'object')
    ? input.tool_input
    : input;

  if (toolName && !WRITE_TOOL_RE.test(toolName)) {
    return {};
  }

  const rawPath = toolInput.file_path || toolInput.target_file || toolInput.TargetFile || toolInput.path;
  if (typeof rawPath !== 'string' || !INSPECTED_EXT_RE.test(rawPath)) {
    return {};
  }

  const baseDir = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const resolved = path.resolve(baseDir, rawPath);
  const warnings = inspectModifiedFile(resolved, toolName);
  if (warnings.length === 0) return {};

  const message = warnings.join('\n');
  return format === 'cursor'
    ? { additional_context: message }
    : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } };
}

function runCli(explicitFormat) {
  const detectedFormat = explicitFormat || (process.env.CURSOR_PLUGIN_ROOT ? 'cursor' : 'standard');
  try {
    const raw = fs.readFileSync(0, 'utf8') || '{}';
    const input = JSON.parse(raw);
    process.stdout.write(JSON.stringify(handle(input, detectedFormat)));
  } catch {
    process.stdout.write('{}');
  }
}

module.exports = { handle, runCli };

if (require.main === module) {
  runCli(process.argv[2]);
}
