# LLMINSTALL — Инструкция для AI-агента по установке «1С · AI Pipeline» (`1c-ai-pipeline`)

Эта инструкция предназначена для автономного выполнения ИИ-агентом (**OpenAI Codex**, **Claude Code**, **Cursor** или другим совместимым клиентом **Agent Plugins 1.0**), когда пользователь просит установить и настроить плагин `1c-ai-pipeline`.

## Правила безопасности для агента

1. **Определи ОС пользователя** (`Windows`, `macOS` или `Linux`) и **активный клиент ИИ** до запуска команд.
2. **Не затирай существующие пользовательские конфиги**: если файл настроек `settings.json` или конфигурация MCP клиента уже существует, аккуратно объедини поля JSON/TOML, сохранив прежние ключи.
3. **Не завершай запущенные процессы 1С** (`1cv8`, `1cv8c`, `rphost`, `rmngr`, `ragent`, `1cedt`) и не перезаписывай рабочие информационные базы.

---

## Шаг 1. Клонирование головного репозитория плагина

Если ты ещё не находишься внутри локального клона `vanessa-ai-pipeline`, склонируй репозиторий в удобный каталог инструментов пользователя (например, `~/tools/vanessa-ai-pipeline` на macOS/Linux или `%USERPROFILE%\tools\vanessa-ai-pipeline` на Windows):

```sh
git clone https://github.com/infostart-hub/vanessa-ai-pipeline.git
```

Перейди в корень клона `vanessa-ai-pipeline`. Пакет плагина расположен внутри по пути `.agents/plugins/1c-ai-pipeline`.

---

## Шаг 2. Проверка `Node.js` и кроссплатформенная подготовка через `mise`

Для работы защитных хуков (`hooks/*.cjs`) и запускателя `bin/vanessa-runner-mcp.cjs` нужен **Node.js >= 18** (в `mise.toml` зафиксирована LTS-версия **`24.18.1`**).

1. Проверь наличие `mise` (`mise --version`) и `node` (`node --version`).
2. Если `mise` ещё не установлен, предложи или выполни штатную установку под текущую ОС:
   - **Windows**: `winget install jdx.mise` *(или в PowerShell: `irm https://mise.run/powershell | iex`)*
   - **macOS**: `brew install mise` *(или `curl -fsSL https://mise.run | sh`)*
   - **Linux**: `curl -fsSL https://mise.run | sh`
3. В корне `vanessa-ai-pipeline` выполни:
   ```sh
   mise trust
   mise install
   ```
   *(Если `Node.js >= 18` уже установлен глобально, а пользователь не хочет ставить `mise`, базовый плагин из `.agents/plugins/1c-ai-pipeline` полностью работоспособен и без `mise`.)*

---

## Шаг 3. Подключение плагина `1c-ai-pipeline` в клиенте ИИ

Подключи единственную карточку плагина `1c-ai-pipeline` способом, штатным для текущего клиента:

- **OpenAI Codex**:
  - Подключи локальный marketplace из `<ПУТЬ_К_КЛОНУ>/.agents/plugins/marketplace.json` (или пакет `<ПУТЬ_К_КЛОНУ>/.agents/plugins/1c-ai-pipeline`):
    ```sh
    codex plugin marketplace add <ПУТЬ_К_КЛОНУ>
    codex plugin add 1c-ai-pipeline@1c-ai-pipeline
    ```
- **Claude Code**:
  - Зарегистрируй локальный каталог `.claude-plugin/marketplace.json` и установи плагин (через CLI или slash-команды сессии):
    ```text
    /plugin marketplace add <ПУТЬ_К_КЛОНУ>
    /plugin install 1c-ai-pipeline@1c-ai-pipeline
    ```
    *(Для разового запуска из терминала также работает `claude --plugin-dir <ПУТЬ_К_КЛОНУ>/.agents/plugins/1c-ai-pipeline`.)*
- **Cursor**:
  - Подключи плагин через совместимый манифест `<ПУТЬ_К_КЛОНУ>/.cursor-plugin/marketplace.json` (пакет `.agents/plugins/1c-ai-pipeline`).

> После Шага 3 сразу становятся активны **все 44 навыка** (`30` предметных `onec-*`, `13` инструментальных `edt-mcp-project-*`, `1` `vanessa-runner`), двуязычный шаблон правил `rules/` и **3 защитных хука** (`SessionStart`, `PreToolUse`, `PostToolUse`).

---

## Шаг 4. Сопутствующие MCP-компоненты (по наличию 1С / 1С:EDT или по запросу пользователя)

Если на машине пользователя установлена платформа **1С:Предприятие 8**, **OneScript** или **1С:EDT** (либо пользователь попросил полную установку с MCP-серверами), подготовь публичные форки в соседние gitignored-каталоги внутри клона `vanessa-ai-pipeline`:

| Каталог (в `.gitignore`) | Публичный форк (`origin`) | Базовый апстрим (`upstream`) |
|---|---|---|
| `./edt-mcp` | `https://github.com/infostart-hub/edt-mcp-aiadopted.git` | `https://github.com/DitriXNew/EDT-MCP.git` |
| `./vanessa-runner` | `https://github.com/infostart-hub/vanessa-runner-aiadopted.git` | `https://github.com/vanessa-opensource/vanessa-runner.git` |
| `./vanessa-automation` | `https://github.com/infostart-hub/vanessa-automation-aiadopted.git` | `https://github.com/Pr-Mex/vanessa-automation.git` |

1. **Клонирование всех трёх форков одной кроссплатформенной командой** из корня `vanessa-ai-pipeline`:
   ```sh
   mise run forks:clone
   ```
   *(Если `mise` не используется — выполни `git clone` нужных репозиториев из таблицы в `./edt-mcp`, `./vanessa-runner`, `./vanessa-automation`.)*

2. **Настройка `vanessa-runner` (MCP исполнения в ИБ и автотестов)**:
   - **На Windows** (с установленным `mise`):
     ```powershell
     cd vanessa-runner
     mise trust
     mise install
     mise run setup
     ```
   - **На macOS / Linux**: релиз `ovm` с GitHub рассчитан на Windows, поэтому проверь установленный нативный **OneScript 2.2.1** (`oscript -version`, дистрибутив с `https://oscript.io/downloads`), затем в каталоге `./vanessa-runner` выполни:
     ```sh
     opm install --local --dev
     opm install --local autumn-logos@1.3.3
     git apply --ignore-space-change --reverse --check patches/autumn-mcp-discovery.patch 2>/dev/null || git apply --ignore-space-change patches/autumn-mcp-discovery.patch
     ```
   - Пропиши абсолютный путь к `vanessa-runner` (и при необходимости к `oscript`) в пользовательский `settings.json`, чтобы MCP-запускатель работал из любого проекта 1С:
     - **macOS / Linux**: `~/.config/1c-ai-pipeline/settings.json`
     - **Windows**: `%APPDATA%\1c-ai-pipeline\settings.json`
     ```json
     {
       "runner_root": "<АБСОЛЮТНЫЙ_ПУТЬ_К_КЛОНУ>/vanessa-runner"
     }
     ```

3. **Проверка `edt-mcp` (1С:EDT)**:
   - Сервер ожидается по штатному адресу `http://127.0.0.1:8765/mcp`, когда в запущенной **1С:EDT** установлен и включён плагин из `./edt-mcp` (`edt-mcp-aiadopted`, сборка p2 описана в `./edt-mcp/SETUP.md`). Не считай отсутствие запущенного окна 1С:EDT ошибкой установки плагина.

---

## Шаг 5. Обязательная финальная самодиагностика и отчёт пользователю

В корне `vanessa-ai-pipeline` выполни проверку хуков и диагностики запускателя:

```sh
mise run check
```

или напрямую через `node`:

```sh
node .agents/plugins/1c-ai-pipeline/bin/vanessa-runner-mcp.cjs --check
```

Заверши установку коротким сводным отчётом пользователю:
1. Путь установленного клона `vanessa-ai-pipeline` и статус подключения плагина `1c-ai-pipeline` в клиенте.
2. Статус `Node.js` / `mise` и всех 3 защитных хуков (`SessionStart`, `PreToolUse`, `PostToolUse`).
3. Статус опциональных MCP-серверов:
   - `vanessa-runner`: готов (`exit code 0`) или отложен до установки OneScript / клона `vanessa-runner` (`exit code 2`);
   - `edt-mcp`: отвечает на `127.0.0.1:8765/mcp` или ожидает запуска 1С:EDT с открытым проектом.
