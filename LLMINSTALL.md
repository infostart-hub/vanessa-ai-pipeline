# LLMINSTALL — Протокол для ИИ-агента по установке и настройке `1c-ai-pipeline`

Эта инструкция предназначена для автономного выполнения ИИ-агентом (**OpenAI Codex**, **Claude Code**, **Cursor** и др. совместимыми клиентами **Agent Plugins 1.0**), когда пользователь просит установить и настроить плагин `1c-ai-pipeline`.

## Жёсткие правила выполнения для агента (прочитай перед первой командой)

1. **Один непрерывный проход до конца — без промежуточных отчётов**:
   - **ЗАПРЕЩЕНО** останавливаться на полпути и писать «плагин установлен, но ещё не настроен / `--check` ещё не выполнен».
   - Выполни последовательно **все шаги с 1 по 5** в рамках одного поручения и выдай пользователю **один готовый итоговый отчёт** только после финального запуска `pipeline-deploy.cjs doctor`.
2. **Не пугай пользователя внутренним мусором `PATH` на корпоративных ПК**:
   - На Windows в `PATH` часто встречаются сломанные сторонние обёртки `node.cmd` или нерабочие ссылки `WinGet\Links\codex.exe`. Не пиши пользователю пугающих фраз вроде *«обнаружены неработающие Node.js и Codex»* — спокойно используй `mise exec -- node` и штатный бинарник клиента ИИ из вывода `pipeline-deploy.cjs doctor --json`.
3. **Не трогай запущенные процессы 1С и рабочие базы**:
   - Не останавливай процессы `1cv8`, `1cv8c`, `1cedt`, `rphost`, `rmngr`, `ragent` и не затирай существующие пользовательские конфиги (аккуратно дополняй JSON/TOML).

---

## Шаг 1. Клонирование головного репозитория плагина

Если ты ещё не находишься внутри локального клона `vanessa-ai-pipeline`, склонируй его в постоянный каталог инструментов пользователя (`~/tools/vanessa-ai-pipeline` на macOS/Linux или `%USERPROFILE%\tools\vanessa-ai-pipeline` на Windows):

```sh
git clone https://github.com/infostart-hub/vanessa-ai-pipeline.git
```

Перейди в корень клона `vanessa-ai-pipeline`. Пакет плагина расположен внутри по пути `.agents/plugins/1c-ai-pipeline`.

---

## Шаг 2. Подготовка `mise` и `Node.js 24.18.1`

Для работы защитных хуков (`hooks/*.cjs`), запускателя `bin/vanessa-runner-mcp.cjs` и оркестратора развёртывания `bin/pipeline-deploy.cjs` нужен **Node.js >= 18** (в `mise.toml` закреплена LTS-версия **`24.18.1`**).

1. Проверь наличие `mise`. Если `mise` ещё не установлен — установи его под текущую ОС:
   - **Windows**: `winget install jdx.mise` *(без диалогов подтверждения: `winget install jdx.mise --accept-source-agreements --accept-package-agreements`, либо в PowerShell: `irm https://mise.run/powershell | iex`)*
   - **macOS**: `brew install mise` *(или `curl -fsSL https://mise.run | sh`)*
   - **Linux**: `curl -fsSL https://mise.run | sh`
2. В корне клона `vanessa-ai-pipeline` выполни:
   ```sh
   mise trust
   mise install
   ```
3. Если в неинтерактивной оболочке обычный вызов `node --version` отсутствует или падает на стороннем битом скрипте в `PATH`, запускай все дальнейшие команды Node через `mise exec -- node ...`.

---

## Шаг 3. Автоматическое развёртывание окружения 1С (`pipeline-deploy.cjs deploy`)

**До** регистрации плагина в клиенте запусти штатный оркестратор развёртывания из корня клона `vanessa-ai-pipeline`:

- **На Windows**:
  ```powershell
  mise exec -- node .agents/plugins/1c-ai-pipeline/bin/pipeline-deploy.cjs deploy --fix-user-path --json
  ```
- **На macOS / Linux**:
  ```sh
  mise exec -- node .agents/plugins/1c-ai-pipeline/bin/pipeline-deploy.cjs deploy --json
  ```

Что эта команда делает автоматически и идемпотентно:
1. На Windows (при флаге `--fix-user-path`, если глобальный `node` в `PATH` отсутствует или сломан) безопасно поднимает `%LOCALAPPDATA%\mise\shims` в начало пользовательского `Path` без повреждения системных переменных `REG_EXPAND_SZ`.
2. Клонирует в соседние gitignored-каталоги три адаптированных репозитория из `infostart-hub`:

   | Каталог (в `.gitignore`) | Публичный форк (`origin`) | Базовый апстрим (`upstream`) |
   |---|---|---|
   | `./edt-mcp` | `https://github.com/infostart-hub/edt-mcp-aiadopted.git` | `https://github.com/DitriXNew/EDT-MCP.git` |
   | `./vanessa-runner` | `https://github.com/infostart-hub/vanessa-runner-aiadopted.git` | `https://github.com/vanessa-opensource/vanessa-runner.git` |
   | `./vanessa-automation` | `https://github.com/infostart-hub/vanessa-automation-aiadopted.git` | `https://github.com/Pr-Mex/vanessa-automation.git` |
3. Устанавливает OneScript `2.2.1` (через `ovm` в `vanessa-runner` на Windows или нативный OneScript на macOS/Linux), ставит пакеты `opm` и применяет патч `patches/autumn-mcp-discovery.patch`.
4. Находит установленные версии платформы **1С:Предприятие 8** (`1cv8`), **OneScript** (включая каталоги версий `%LOCALAPPDATA%\ovm\<версия>\bin\oscript.exe` без `current`), **1С:EDT** (и её комплектную JVM из `1cedt.ini`).
5. Если **1С:EDT** установлена на компьютере, но плагин `EDT MCP` в неё ещё не поставлен (и окно 1С:EDT закрыто) — автоматически устанавливает плагин `com.ditrix.edt.mcp.server` через штатный `p2.director`, проверяет отсутствие конфликта на порту `8765` (если `8765` занят посторонним процессом, подбирает свободный порт, например `8766`) и прописывает все абсолютные пути в `settings.json` (`%APPDATA%\1c-ai-pipeline\settings.json` на Windows / `~/.config/1c-ai-pipeline/settings.json` на macOS/Linux).

> **Если порт `8765` занят посторонним процессом** (`doctor.edt.status == "port_conflict"` или `port8765Conflict == true`, например другой локальный процесс отвечает `HTTP 404`): запомни свободный порт `doctor.edt.suggestedPort` (обычно `8766`) — после установки в клиенте синхронизируй URL `edt-mcp` на `http://127.0.0.1:<suggestedPort>/mcp`.

---

## Шаг 4. Подключение плагина `1c-ai-pipeline` в клиенте ИИ

Возьми путь к рабочему исполняемому файлу клиента из поля `doctor.aiClients` отчёта Шага 3 (на Windows для десктопного Codex используй найденный `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`, не вызывай битую ссылку `WinGet\Links\codex.exe`):

- **OpenAI Codex** (CLI или Codex Desktop):
  ```sh
  "<CODEX_EXECUTABLE>" plugin marketplace add "<АБСОЛЮТНЫЙ_ПУТЬ_К_КЛОНУ>" --json
  "<CODEX_EXECUTABLE>" plugin add 1c-ai-pipeline@1c-ai-pipeline --json
  ```
- **Claude Code**:
  ```text
  /plugin marketplace add <АБСОЛЮТНЫЙ_ПУТЬ_К_КЛОНУ>
  /plugin install 1c-ai-pipeline@1c-ai-pipeline
  ```
  *(либо через CLI `claude` / флаг `--plugin-dir <АБСОЛЮТНЫЙ_ПУТЬ_К_КЛОНУ>/.agents/plugins/1c-ai-pipeline`)*
- **Cursor**:
  Подключи пакет через совместимый манифест `<АБСОЛЮТНЫЙ_ПУТЬ_К_КЛОНУ>/.cursor-plugin/marketplace.json` (`.agents/plugins/1c-ai-pipeline`).

---

## Шаг 5. Финальная верификация (`mise run check` и `doctor`) и понятный отчёт пользователю

В корне `vanessa-ai-pipeline` выполни обе финальные проверки:

```sh
mise run check
mise exec -- node .agents/plugins/1c-ai-pipeline/bin/pipeline-deploy.cjs doctor
```

Убедись, что:
- все 3 защитных хука (`SessionStart`, `PreToolUse`, `PostToolUse`) вернули код `0`;
- если на компьютере есть платформа 1С / OneScript — `vanessa-runner-mcp.cjs --check` вернул `"ready": true` (код `0`), а `doctor` подтвердил ответ MCP-сервера `Vanessa Runner` (71 инструмент).

### Что обязательно написать пользователю в итоговом отчёте

1. **Короткая сводка готовности по фактам**:
   - Плагин `1c-ai-pipeline` (45 навыков + 3 защитных хука): установлен и включён.
   - Платформа 1С и `Vanessa Runner MCP`: точная найденная версия платформы и готовность `Vanessa Runner` (`ready: true`, 71 инструмент — сервер запускается самим чатом автоматически в фоне).
   - Связка с **1С:EDT (`EDT MCP`)** — строго по фактическому `edt.status` (без расплывчатого «404 недоступен»!):
     - если `ready` или `edt_not_running`: укажи, что плагин в 1С:EDT установлен, и напомни, что `EDT MCP` работает тогда, когда открыто само окно 1С:EDT с проектом;
     - если `edt_not_installed` (**1С:EDT на ПК не установлена**):
       1) прямо скажи, что **ждать установки 1С:EDT не нужно — начинать работу с базой КА / ЗУП можно уже сейчас** напрямую через установленную Платформу 1С и `Vanessa Runner`;
       2) если пользователю также нужна среда **1С:EDT**, дай **прямые официальные ссылки «1С»** (не пиши «найдите в официальной поставке»!):
          - Официальный сайт: `https://edt.1c.ru/`
          - Прямой раздел загрузки на портале релизов: `https://releases.1c.ru/project/DevelopmentTools10` (*бесплатно по обычной бесплатной учётной записи `portal.1c.ru`, платный договор ИТС для скачивания 1С:EDT не требуется*)
          - Комьюнити-лицензия разработчика 1С (при необходимости): `https://developer.1c.ru/`
          - Что ставить: через установщик **1C:EDT Start** поставить версию **1С:EDT `2025.2`, `2026.1` или `2026.2`**, после чего выполнить одну команду `node <ПУТЬ_К_КЛОНУ>/.agents/plugins/1c-ai-pipeline/bin/pipeline-deploy.cjs deploy-edt` (при занятом порте `8765` она автоматически настроит свободный порт `8766`).

2. **Как перезапустить клиент перед началом работы**:
   - Если на Шаге 3 менялся пользовательский `Path` Windows (`windows_user_path.changed == true`), скажи **полностью закрыть и заново открыть приложение Codex / Cursor** (чтобы оно подхватило новый `Path` с `node.exe`). В остальных случаях достаточно **открыть новый чат**.

3. **Как начать работу на своей базе 1С:КА или 1С:ЗУП (объясни простым языком про исходники!)**:
   - Прямо поясни: **отдельно искать или скачивать «исходники в формате EDT» не нужно** — работа ведётся от вашей **тестовой копии базы КА или ЗУП** (боевую базу не подключать, пароль в чат не писать).
   - Дай пользователю готовый текст первого сообщения для нового чата под его реальный сценарий:
     - **Вариант 1 (сразу по тестовой копии базы КА / ЗУП, даже без 1С:EDT)**:
       ```text
       Подключи мою тестовую копию базы [КА / ЗУП] по пути [D:\Bases\TestBase]. Проверь доступность окружения (onec-setup-and-connect), при необходимости выгрузи нужные метаданные/модули и разбери задачу без изменения данных: [описание расхождения в движениях или начислениях].
       ```
     - **Вариант 2 (через 1С:EDT — для доработки форм, СКД и расширений)**:
       Поясни, что для доработки типовой КА/ЗУП не нужно импортировать всю типовую конфигурацию в EDT на 30–40 минут: достаточно в 1С:EDT создать проект **Расширения конфигурации** (`Файл → Новый → Проект расширения конфигурации`), привязанный к тестовой копии базы (или импортировать базу через панель `Информационные базы`), убедиться, что окно 1С:EDT открыто, и отправить задачу в новый чат.
