# 1С · AI Pipeline

Единый подключаемый плагин формата **Agent Plugins 1.0** (`1c-ai-pipeline`) для проектирования, доработки, ревью и автоматизированной проверки решений на платформе **1С:Предприятие 8** (включая БСП, 1С:КА/ERP, 1С:ЗУП, ЭДО/Честный ЗНАК/ЕГАИС, КД 2/КД 3, 1С:EDT, OneScript и Vanessa Automation).

## Быстрая установка через AI-агента (`LLMINSTALL.md`)

Чтобы не настраивать окружение вручную, скопируйте и отправьте своему AI-агенту (OpenAI Codex, Claude Code, Cursor и др.) одну фразу:

```text
Установи и настрой плагин 1c-ai-pipeline по инструкции: https://raw.githubusercontent.com/infostart-hub/vanessa-ai-pipeline/main/LLMINSTALL.md
```

Локальная копия пошагового протокола для агента лежит в корне репозитория: [`LLMINSTALL.md`](LLMINSTALL.md).

## Архитектура плагина

Пакет расположен в [`.agents/plugins/1c-ai-pipeline`](.agents/plugins/1c-ai-pipeline) и объединяет четыре взаимодополняющих уровня в одной карточке плагина:

1. **Предметный уровень (`onec-*`, 31 навык)** — методология, онбординг стенда (`onec-setup-and-connect`) и учётные инварианты 1С: требования и Fit/Gap, расширения и режимы совместимости, управляемые и обычные формы, асинхронный клиентский код, составление запросов и СКД, роли и RLS, транзакции и управляемые блокировки, Хранилище конфигурации 1С, КД 2 / КД 3 (`EnterpriseData`), интеграции/OData/XDTO, ЭДО/МЧД/Честный ЗНАК/ЕГАИС, печатные формы MXL, БСП, подписки и фоновые задания, техжурнал, ревью кода, диагностика движений КА/ERP и начислений ЗУП, модульные и сценарные тесты.
2. **Инструментальный уровень EDT (`edt-mcp-project-*`, 13 навыков)** — протоколы безопасного чтения, навигации, точечной правки BSL/метаданных/форм/СКД, профилирования, отладки и запуска YAxUnit через MCP-сервер 1С:EDT.
3. **Уровень исполнения в ИБ (`vanessa-runner`, 1 навык)** — управляемая инициализация баз, проверка синтаксиса, запуск клиента 1С и автономный прогон BDD-сценариев Vanessa Automation с JUnit/Allure-отчётами.
4. **Защитные хуки (`hooks/`, 3 события жизненного цикла)** — кроссплатформенные перехватчики для OpenAI Codex, Claude Code и Cursor:
   - `SessionStart` (`hooks/session-start.cjs`) — двухуровневая маршрутизация навыков и контроль фактической доступности MCP;
   - `PreToolUse` (`hooks/pre-tool-guard.cjs`) — блокировка порчи бинарных и служебных файлов 1С (`ConfigDumpInfo.xml`, `ParentConfigurations.bin`, `Form.bin`, `1Cv8.1CD`), записи нулевых UUID в метаданные, самовольного `/ConfigurationRepositoryUnbindCfg`, убийства процессов кластера (`rphost`/`rmngr`/`ragent`) и несанкционированной перезаписи серверных баз (`Srvr=`);
   - `PostToolUse` (`hooks/post-tool-hygiene.cjs`) — мгновенная проверка сохранённых исходников 1С на потерю `UTF-8 BOM` в выгрузке Конфигуратора (`Ext/*.bsl`), повреждение кириллицы (`U+FFFD` / NUL) и прямую правку `.mdo`/`.form` в обход модели 1С:EDT.

> Предметные навыки `onec-*` и защитные хуки полностью работоспособны сами по себе (для анализа кода, ревью и проектирования по выгрузке исходников), даже если локальные MCP-серверы `edt-mcp` и `vanessa-runner` в данный момент не запущены.

## Кроссплатформенное окружение (`mise`) и требования

В корне репозитория (и в сопутствующих форках `vanessa-runner` / `vanessa-automation`) используется кроссплатформенный менеджер инструментов и задач **[`mise`](https://mise.jdx.dev)** (*mise-en-place*). В [`mise.toml`](mise.toml) зафиксирована версия **Node.js `24.18.1`**, единая для этого репозитория и `vanessa-runner`.

> **Небольшой дисклеймер про `mise`**: если в вашей системе уже установлен **Node.js >= 18** в `PATH`, сам плагин `1c-ai-pipeline` (навыки, защитные хуки и запускатель MCP) работает сразу и без `mise`. Установка `mise` рекомендуется, чтобы одинаково и без засорения глобального `PATH` поднимать фиксированную версию Node.js, зависимости сопутствующих форков и проверочные задачи на **Windows, Linux и macOS**.

Установка `mise` в одну команду под вашу ОС:

- **Windows (Winget / PowerShell)**:
  ```powershell
  winget install jdx.mise
  # альтернатива без Winget: irm https://mise.run/powershell | iex
  ```
- **macOS (Homebrew или скрипт)**:
  ```sh
  brew install mise
  ```
- **Linux / macOS (универсальный скрипт)**:
  ```sh
  curl -fsSL https://mise.run | sh
  ```

После установки `mise` в корне клона доступны задачи развёртывания и самодиагностики:

```sh
mise trust
mise install
mise run deploy   # клонирование форков, настройка Vanessa Runner / EDT MCP и запись settings.json
mise run doctor   # полная диагностика Node/PATH, Платформы 1С, Vanessa Runner, 1С:EDT и портов MCP
mise run check    # проверка манифестов, защитных хуков и запускателя
```

## Публичные репозитории поставки (`infostart-hub`)

| Репозиторий | Назначение | Локальный путь (при клонировании рядом) |
|---|---|---|
| [`infostart-hub/vanessa-ai-pipeline`](https://github.com/infostart-hub/vanessa-ai-pipeline) | Головной репозиторий единого плагина `1c-ai-pipeline` (Agent Plugins 1.0) | `.` (корень) |
| [`infostart-hub/edt-mcp-aiadopted`](https://github.com/infostart-hub/edt-mcp-aiadopted) | Адаптированный публичный форк MCP-плагина для 1С:EDT | `./edt-mcp` *(в `.gitignore`)* |
| [`infostart-hub/vanessa-runner-aiadopted`](https://github.com/infostart-hub/vanessa-runner-aiadopted) | Адаптированный публичный форк Vanessa Runner с MCP-сервером и супервизором сеансов 1С | `./vanessa-runner` *(в `.gitignore`)* |
| [`infostart-hub/vanessa-automation-aiadopted`](https://github.com/infostart-hub/vanessa-automation-aiadopted) | Адаптированный публичный форк Vanessa Automation для автономных сценарных проверок | `./vanessa-automation` *(в `.gitignore`)* |

Склонировать все три сопутствующих форка в игнорируемые соседние каталоги одной командой:

```sh
mise run forks:clone
```

## Настройка MCP-серверов

### 1. MCP-сервер `edt-mcp` (1С:EDT)

В [`mcp.json`](.agents/plugins/1c-ai-pipeline/mcp.json) подключение `edt-mcp` настроено на штатный локальный HTTP-порт плагина 1С:EDT по умолчанию:

```text
http://127.0.0.1:8765/mcp
```

Установите плагин **EDT MCP Server** (автоматически командой `node .agents/plugins/1c-ai-pipeline/bin/pipeline-deploy.cjs deploy-edt` при закрытой 1С:EDT либо вручную из [`edt-mcp-aiadopted`](https://github.com/infostart-hub/edt-mcp-aiadopted), см. `SETUP.md`), откройте нужный проект конфигурации/расширения и убедитесь, что встроенный сервер запущен на порту `8765` (если `8765` занят посторонним локальным процессом, `pipeline-deploy.cjs` автоматически подберёт свободный порт, например `8766`).

Если **1С:EDT** на компьютере ещё не установлена:
- официальный установщик **1C:EDT Start** и дистрибутивы **1С:EDT** (`2025.2` / `2026.1` / `2026.2`) скачиваются **бесплатно** с [`https://edt.1c.ru/`](https://edt.1c.ru/) или [`https://releases.1c.ru/project/DevelopmentTools10`](https://releases.1c.ru/project/DevelopmentTools10) по обычной бесплатной учётной записи `portal.1c.ru` (платный договор ИТС для скачивания EDT не нужен; комьюнити-лицензия разработчика при необходимости оформляется на [`https://developer.1c.ru/`](https://developer.1c.ru/));
- ждать установки 1С:EDT для старта не обязательно — при наличии платформы 1С и `Vanessa Runner` можно сразу работать с тестовой копией базы (КА / ЗУП / ERP) напрямую.

### 2. MCP-сервер `vanessa-runner` (OneScript + платформа 1С)

Запускатель [`bin/vanessa-runner-mcp.cjs`](.agents/plugins/1c-ai-pipeline/bin/vanessa-runner-mcp.cjs) работает через `stdio` без промежуточных прокси и ищет:
- исполняемый файл **OneScript** (`oscript` в `PATH`, установках OVM, `OSCRIPT_BIN` или поле `"oscript"` в `settings.json`);
- рабочий каталог **Vanessa Runner** с установленными модулями `oscript_modules` (`VANESSA_RUNNER_ROOT`, поле `"runner_root"` в `settings.json` или соседний каталог `./vanessa-runner`).

Подготовка локального клона [`vanessa-runner-aiadopted`](https://github.com/infostart-hub/vanessa-runner-aiadopted):
- на **Windows** через `mise` (`cd vanessa-runner && mise trust && mise install && mise run setup`);
- на **macOS / Linux** с установленным нативным OneScript `2.2.1`:
  ```sh
  opm install --local --dev
  opm install --local autumn-logos@1.3.3
  git apply --ignore-space-change --reverse --check patches/autumn-mcp-discovery.patch 2>/dev/null || git apply --ignore-space-change patches/autumn-mcp-discovery.patch
  ```

Явную привязку путей можно сохранить в пользовательский файл настроек (тогда плагин будет находить `vanessa-runner` из любого рабочего проекта 1С):
- **macOS / Linux**: `~/.config/1c-ai-pipeline/settings.json` (либо `${PLUGIN_DATA}/settings.json`)
- **Windows**: `%APPDATA%\1c-ai-pipeline\settings.json`

Пример `settings.json`:

```json
{
  "oscript": "/usr/local/bin/oscript",
  "runner_root": "/opt/vanessa-runner"
}
```

### Самодиагностика перед запуском

Проверить готовность `oscript`, `runner_root`, точки входа `src/mcp.os` и зависимостей `oscript_modules` без старта сервера:

```sh
node .agents/plugins/1c-ai-pipeline/bin/vanessa-runner-mcp.cjs --check
```

Команда выводит JSON-отчёт по каждому требованию и возвращает код `0` при полной готовности либо `2`, если компонент не найден.

### Опциональные открытые инструменты для проектов без запущенного 1С:EDT

Если работа ведётся по классической XML-выгрузке Конфигуратора или отдельным внешним обработкам без подъёма 1С:EDT, плагин можно сочетать с открытыми серверами сообщества в пользовательской конфигурации MCP/LSP клиента:
- **`1c-syntax/bsl-language-server`** (режим LSP / встроенный MCP) — статический анализ и навигация по символам `.bsl` и `.os`;
- **`alkoleft/mcp-bsl-platform-context`** — локальный поиск сигнатур встроенного языка по штатной справке установленной платформы (`shcntx_ru.hbk`);
- **`MaxVMarkov/1c-debug-mcp`** — прямое подключение к серверу отладки кластера 1С (`dbgs` / RDBG);
- **`Romandredan/odata1c-gate`** — чтение тестовой копии ИБ по OData с локальной псевдонимизацией ИНН, телефонов, ФИО и счетов.

## Каталог навыков (45)

- **Развёртывание стенда, анализ, архитектура, хранилище и поставка**: `onec-setup-and-connect`, `onec-requirements-analysis`, `onec-configuration-overview`, `onec-change-impact`, `onec-extension-change`, `onec-configuration-repository`, `onec-external-processors-and-delivery`, `onec-code-review-and-standards`.
- **Объекты, формы, запросы, отчёты, печать и БСП**: `onec-object-lifecycle`, `onec-managed-form-design`, `onec-query-composition`, `onec-dcs-design`, `onec-print-forms-and-mxl`, `onec-bsp-api`, `onec-event-subscriptions-and-jobs`.
- **Надёжность, права, конвертация, интеграции и регуляторика РФ**: `onec-transactions-and-locks`, `onec-access-and-roles`, `onec-data-conversion-kd`, `onec-integration-and-exchange`, `onec-xdto-import`, `onec-regulatory-edo-marking`, `onec-performance-and-cluster`, `onec-techlog-and-diagnostics`.
- **Учётная диагностика и смежные технологии**: `onec-movement-diagnosis`, `onec-ka-incident-router`, `onec-zup-payroll-diagnostics`, `onec-onescript-and-autumn`, `onec-element-development`.
- **Тестирование и исполнение в ИБ**: `onec-vanessa-scenario`, `vanessa-runner`, `onec-yaxunit-tests`, `onec-xunit-tests`.
- **Инструментальные навыки 1С:EDT (`edt-mcp-project-*`)**: `session`, `code-research`, `local-fix`, `metadata`, `forms`, `query-dcs`, `external-objects`, `runtime-debug`, `profiling`, `yaxunit`, `maintenance`, `translation`, `workmate`.

## Шаблон постоянных проектных правил (`rules/`)

В каталоге [`.agents/plugins/1c-ai-pipeline/rules/`](.agents/plugins/1c-ai-pipeline/rules/README.md) поставляется опциональный двуязычный шаблон постоянных правил проекта (`ru/` и `en/`), который при желании можно скопировать в корень конкретного репозитория конфигурации 1С. Навыки из `skills/` и защитные хуки из `hooks/` подхватываются самим плагином автоматически и ручного копирования не требуют.

## Уведомления об авторских правах

Уведомления и тексты лицензий используемых открытых компонентов и методических материалов третьих сторон приведены в [`.agents/plugins/1c-ai-pipeline/LICENSES/`](.agents/plugins/1c-ai-pipeline/LICENSES).
