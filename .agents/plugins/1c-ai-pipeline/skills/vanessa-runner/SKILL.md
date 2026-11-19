---
name: vanessa-runner
description: "Управляет информационными базами 1С, запуском клиента и автономным прогоном сценариев Vanessa Automation через MCP-сервер vanessa-runner с получением JUnit/Allure-отчётов и контролем завершения процессов на Windows и macOS."
---

# Vanessa Runner (MCP-исполнение и дымовая проверка в ИБ)

Используй инструменты MCP-сервера `vanessa-runner` для операций с информационной базой, управляемого запуска клиента `1С:Предприятие` и прогона `.feature`-сценариев Vanessa Automation.

## Перед вызовом инструментов

1. Проверь фактическую доступность инструментов `vanessa-runner` в текущем сеансе. Наличие манифеста плагина или отдельного CLI в терминале не доказывает доступность MCP-сервера в чате: если сервер не подключён, сообщи об этом прямо и чётко отделяй возможный запуск через CLI от вызова MCP.
2. Запускатель плагина (`bin/vanessa-runner-mcp.cjs`) находит `oscript` и каталог Runner (`VANESSA_RUNNER_ROOT`, `PLUGIN_DATA/settings.json`, `~/.config/1c-ai-pipeline/settings.json` / `%APPDATA%\1c-ai-pipeline\settings.json` или соседний клон `vanessa-runner`) и запускает `src/mcp.os` при установленных `oscript_modules` и платформе 1С. Если клиент ограничивает число инструментов, ориентируйся на список `enabled_tools` в `docs/mcp-local-setup.md` поставки Runner.
3. Не включай `debug: true` при штатном прогоне (он делает вызов синхронным и засоряет контекст дампом окружения). Для независимых баз передавай явную строку подключения и `nocache: true` (`cache_show` показывает закэшированные параметры).

## Выбор режима запуска `test_vanessa`

- **В окружении заданы базовые настройки (`runnerDefaultsConfigured`)**: передавай в `test_vanessa` только путь к `.feature`, `nocache: true` и `background: true` — Runner унаследует ИБ, платформу, EPF, рабочую папку и библиотеки шагов из настроек, а отчёты JUnit/Allure сохранит в `runtime/runs/<runId>`. Если тестовая ИБ уже подготовлена, не пересоздавай её через `infobase_init`.
- **Настройки по умолчанию не заданы**: передавай явные `ibconnection`, `bddrunner-path`, `vanessasettings`, `workspace`, `v8version`, `nocache: true`, `background: true`. Каждый новый прогон должен писать отчёты в собственный чистый каталог.
- **Трактовка результата**:
  - `scenarioStatus: passed` — проверки сценария пройдены;
  - `scenarioStatus: failed` при сформированном JUnit/Allure и штатно завершившихся процессах — воспроизведённое предметное расхождение (дефект), а не поломка самого Runner;
  - нулевой код возврата процесса или `state: exited` **без** `scenarioStatus` и файлов отчёта успешным тестом не является.

## Жизненный цикл ИБ и клиента: создать → открыть → проверить → закрыть

1. **Инициализация новой файловой ИБ (`infobase_init`)**: выбери новый пустой каталог в разрешённой рабочей папке. **Внимание**: `infobase_init` удаляет существующий каталог перед созданием базы — никогда не вызывай его для открытия готовой ИБ. Передавай явные `ibconnection` (`/F` с абсолютным путём), `v8version` и `nocache: true`. Если вернулся `taskId`, дождись `task_status` → `task_result`.
2. **Открытие клиента (`run_enterprise`)**: для файловой ИБ передай `ibpath` и `v8version`; для **Автономного сервера 1С (`ibsrv`)** или кластера — `ibconnection` (`/WS"http://localhost:8314/..."`, `http://...`, `ws="..."`, `/S"host:port\db"`, `Srvr="...";Ref="..."`), `v8version` и при необходимости `dbUser`/`dbPwd`. Статус `state: starting` означает старт: опрашивай `enterprise_status` по `runId` (15–30 с).
3. **Штатное закрытие (`enterprise_stop`)**: вызови `enterprise_stop(runId, timeoutSeconds: 5)` — помощник отправит штатный запрос закрытия собственным клиентам и менеджеру тестирования без принудительного `kill`. Статус `close_pending` означает ожидание закрытия (смотри массив `processes`: `pid`, роль, заголовок окна, `responding`, `closeAccepted`, код выхода).
4. **Критерий полного завершения**: `state: exited`, `cleanupStatus: exited`, `activeProcessCount: 0` и `result: passed` (плюс `scenarioStatus: passed` для BDD). Сочетание `scenarioStatus: passed` с `result: cleanup_pending` означает, что шаги прошли, но процессы ещё не закрылись.
5. **Автономный сервер 1С (`ibsrv` / `ibcmd`)**: к уже работающему `ibsrv` (или `wst-server` из `get_applications` в `edt-mcp`) подключайся через `ibconnection: "/WS\"http://...\""` либо `--ibsrv --ibsrv-attach --ibsrv-port <port>` (чужой процесс `ibsrv` не гасится); для временного подъёма `ibsrv` поверх файловой ИБ передавай `--ibsrv`; для пакетных операций без GUI при остановленном `ibsrv` используй `--ibcmd` (в т. ч. с путём к `config.yaml`, подробнее в справочнике ниже).

## Фоновые задачи (`taskId`) и управляемое наблюдение (`runId`)

- Различай два идентификатора и передавай их буквально (без префиксов и догадок):
  - **`taskId`** — идентификатор фоновой команды внутри текущего экземпляра MCP (`task_status`, `task_result`, `task_cancel`; при этом `task_cancel` отменяет ожидание задачи, но не заменяет штатное закрытие 1С);
  - **`runId`** — UUID запуска предприятия/Vanessa (извлекается из строки `Vanessa runId: ...` в `task_result`), по которому работают `enterprise_status` и `enterprise_stop`.
- На Windows потомки отслеживаются через Job Object (`processTracking: windows_job`), на macOS (без `ibsrv`) — через собственную POSIX-группу процессов. Состояние сохраняется в `%LOCALAPPDATA%/VanessaRunner/runs/<runId>/state.json` и переживает переподключение MCP под тем же пользователем. Статус `supervision_lost` / `supervision_error` означает потерю достоверного наблюдения — не объявляй успех и не перезапускай базу вслепую.

## Синтаксический контроль после загрузки и раннее обнаружение исключений

- После загрузки правок BSL или расширения (`cfe_load`) обязательно выполни **`validate_syntax_check`** для целевого объекта (`target`: имя расширения/конфигурации) в нужных режимах (`ThinClient`, `Server`). Успех `cfe_load`, `validate_query` и отсутствие маркеров в EDT не гарантируют компилируемость всего BSL-модуля в ИБ.
- Во время прогона проверяй свежие `runtimeErrors` и `lastPlatformError` в ответе помощника (`applicationReadiness: needs_attention` требует немедленно разобрать модуль и строку ошибки, не дожидаясь общего таймаута; при `sessionConfirmed: false` сверь событие в общем журнале базы с действием своего сеанса). Пустой вывод `/Out` не доказывает отсутствие ошибки в журнале регистрации.
- При обнаружении ошибки сначала штатно заверши текущий запуск и убедись в `activeProcessCount: 0`, затем загрузи исправление, перепроверь синтаксис и запусти сценарий с новым `runId` (не плоди параллельные клиенты поверх упавшего сеанса и не превышай лимит клиентских лицензий).

## Дополнительные справочники

- [Настройки `vanessasettings`, первичный старт БСП и сборка вспомогательных EPF](references/autonomous-settings-and-bsp.md)
- [Диалоги безопасности 1С, `enterprise_authorize` и настройка доверия тестовых баз](references/security-dialogs-and-trust.md)
- Проектирование самих `.feature`-сценариев и фикстур: см. предметный навык [`onec-vanessa-scenario`](../onec-vanessa-scenario/SKILL.md).
