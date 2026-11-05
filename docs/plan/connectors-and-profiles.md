# План: коннекторы, профили проектов, смежные репозитории

Реализация решений из [ADR 0001–0005](../adr/). Шаги идут по порядку: каждый следующий опирается на предыдущий.

- [x] **0. Проверка условия ADR 0002.** Сухой прогон на codex 0.166.0 (2026-11-05): все три условия выполняются при `default_tools_approval_mode="approve"` на сервере. В `--json` у codex есть события `mcp_tool_call` (сервер, инструмент, статус) — основа для шага 6.
- [x] **1. Конфигурация в два слоя** ([0004](../adr/0004-two-layer-config-one-deploy-per-org.md)). `service.yaml`: движки, бот-аккаунты, коннекторы, профили проектов по glob, `secret:NAME`. Перенос текущего деплоя с env.
  - Файл по пути `SERVICE_CONFIG` (по умолчанию `/config/service.yaml`); разбор — чистая функция `parseServiceConfig(yaml, env)`, ошибки собираются все сразу, значения секретов в них не попадают.
  - Поля-секреты (токены, `webhookSecret`) принимают только `secret:NAME`: открытый текст в файле — ошибка запуска. Ссылка на пустую или отсутствующую переменную — ошибка запуска.
  - `engines.codex` обязателен, `engines.claude` — по наличию секции; бот-аккаунт — `bot: {username, token}` внутри движка.
  - `connectors` и опции профиля `agentNetwork`/`cliTools` разбираются и проверяются (ссылки профиля на коннекторы, `cliTools` только с `agentNetwork`), но подключаются в шаге 2.
  - Профили: `projects` — glob по `path_with_namespace` (`*` — внутри сегмента, `**` — любые сегменты), первый совпавший побеждает; нет совпадения — проект не обслуживается (замена `PROJECT_ALLOWLIST`). `engines` профиля сужает, какие боты отвечают в проекте.
  - Временно в env, до своих шагов: `LINEAR_API_*`, `GITLAB_READ_TOKEN`, `CODEX_MCP_ENABLED`, `CODEX_ONDEMAND_LINEAR` (шаг 2), `DOCS_REPO_*` (шаг 3).
  - Деплой: `service.example.yaml`, монтирование в `docker-compose.yml`, `.env` — только секреты и временные переменные.
- [x] **2. Коннекторы из конфига** ([0002](../adr/0002-connectors-are-configured-mcp-servers.md)). Перевод записей в настройки claude и codex; подсказки в промпт из конфига. Linear и GitLab — на готовых MCP-серверах с токенами только на чтение (выбрать серверы). Описание и треды MR — файлами в каталог джобы. Удалить `ctxmcp`, `cli/linear.ts`, `cli/gitlab.ts`, раскладку Linear на диск, `CODEX_ONDEMAND_LINEAR`, `CODEX_MCP_ENABLED`. Вернуть codex в `read-only` с `default_tools_approval_mode="approve"` на каждом сервере. Опции профиля `agentNetwork` (по умолчанию выкл.) и `cliTools` (требует `agentNetwork`).
  - Перевод — чистые функции `src/connectors/engineConfig.ts`. Имя коннектора — `[A-Za-z0-9-]+`: codex делит ключ `-c` по точкам.
  - Серверы для примера: `@zereight/mcp-gitlab` (`GITLAB_PERMISSION_MODE=readonly`), `@tacticlaunch/mcp-linear`. Имена инструментов в `tools` сверить по `tools/list` при подключении.
  - `cliTools` пока только разрешает команду (`Bash(<tool> *)` у claude); токен для CLI в окружение агента не передаётся.
  - Остаётся в env до шага 4: `LINEAR_API_*` — ими бот скачивает задачу-постановку (`spec/sources.ts`). Задачи GitLab для оси постановки бот качает токеном бота codex; `GITLAB_READ_TOKEN` удалён.
- [ ] **3. Смежные репозитории** ([0005](../adr/0005-related-repos-are-disk-checkouts.md)). `related` в профиле, `same-branch`, `docs-repo` — через этот механизм.
- [ ] **4. Новая предзагрузка** ([0003](../adr/0003-prefetch-only-direct-targets.md)). Правила прямых целей и `issueKeys`; бот — MCP-клиент коннектора; привязанные документы; режимы inline/файлы с проверкой, что каждая цель в чек-листе; картинки из описания MR и целей. Удалить старую `spec/sources.ts` и поиск ключей по всему описанию.
- [ ] **5. `.review.yml` в репозитории** ([0004](../adr/0004-two-layer-config-one-deploy-per-org.md)). Чтение из target-ветки, слияние с профилем (только сужение коннекторов, смежные репозитории из allowlist).
- [ ] **6. Журнал вызовов.** Разбор событий `codex exec --json` / `claude --output-format stream-json`; «Открыто агентом: …» в шапке заметки.
