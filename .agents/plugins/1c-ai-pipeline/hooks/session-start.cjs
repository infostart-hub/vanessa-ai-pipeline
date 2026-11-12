#!/usr/bin/env node
'use strict';
const fs = require('node:fs');

function handle(input, format = 'standard') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const event = input.hook_event_name ?? input.event;
  if (event && !['SessionStart', 'sessionStart'].includes(event)) return {};
  const context = [
    'Подключён плагин «1С · AI Pipeline» (навыки, правила, защитные хуки и MCP-инструменты для 1С:Предприятия).',
    'Используй двухуровневую маршрутизацию навыков до внесения правок: (1) выбери предметный навык onec-* для учётных инвариантов, архитектуры 1С/БСП и критериев приёмки; (2) при работе через MCP подключи парный инструментальный навык edt-mcp-project-* (начиная с edt-mcp-project-session) и/или vanessa-runner.',
    'Операции с проектом EDT и информационной базой выполняй только через фактически доступные в сеансе MCP-серверы (edt-mcp, vanessa-runner). Само наличие манифеста не означает запущенный сервер.',
    'Если нужный MCP-сервер или инструмент недоступен, явно сообщи об этом ограничении, не имитируй вызов инструмента и работай по доступным исходникам проекта.',
    'Эти инструкции относятся к задачам по 1С и дополняют правила текущего репозитория.'
  ].join('\n');
  return format === 'cursor'
    ? { additional_context: context }
    : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
}

function runCli(explicitFormat) {
  const detectedFormat = explicitFormat || (process.env.CURSOR_PLUGIN_ROOT ? 'cursor' : 'standard');
  try {
    const raw = fs.readFileSync(0, 'utf8') || '{}';
    const input = JSON.parse(raw);
    process.stdout.write(JSON.stringify(handle(input, detectedFormat)));
  } catch {
    process.stderr.write('1c-ai-pipeline session hook: invalid input; context omitted.\n');
    process.stdout.write('{}');
  }
}

module.exports = { handle, runCli };

if (require.main === module) {
  runCli(process.argv[2]);
}
