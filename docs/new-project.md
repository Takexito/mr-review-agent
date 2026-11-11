# Подключить новый проект

Бот уже развёрнут (README → «Быстрый старт», DEPLOY.md), нужно научить его работать ещё в одном
проекте GitLab. Справочник по каждому полю — комментарии в [`service.example.yaml`](../service.example.yaml).

В примерах — значения текущего деплоя: бот-аккаунт `codex_bot` (тегать `@codex_bot`; имя задаёт
`engines.codex.bot.username`), публичный адрес `https://review-bot.example.com` (постоянный
туннель из DEPLOY.md). Проект — `my-group/my-app`, смежный репозиторий — `my-group/my-docs`.

Команды ниже — из корня репозитория бота, `glab` залогинен под пользователем с правом Maintainer
в проекте.

```bash
P=my-group%2Fmy-app                                   # путь проекта, / → %2F
BOT_ID=$(glab api 'users?username=codex_bot' | jq '.[0].id')
```

## 1. Доступ бот-аккаунта

Бот клонирует репозиторий и пишет заметки и треды в MR от этого аккаунта. Роль — Developer (30);
Reporter (20) хватает для клона и чтения.

```bash
glab api -X POST "projects/$P/members" -f user_id="$BOT_ID" -F access_level=30
# уже участник (409) — сменить роль:
# glab api -X PUT "projects/$P/members/$BOT_ID" -F access_level=30
```

Смежным репозиториям (`related`) нужно не ниже Reporter. Проверить, что доступ уже есть (с учётом
унаследованного от группы):

```bash
glab api "projects/my-group%2Fmy-docs/members/all/$BOT_ID" | jq .access_level   # ≥ 20
```

## 2. Вебхук — в каждом проекте

Вебхуки группы есть только в GitLab Premium; на Free (как у `acme`) вебхук заводится в каждом
проекте отдельно. Нужны только **Comments** (Note events): GitLab по умолчанию включает ещё
**Push events** — их надо снять, иначе каждый пуш будет уходить боту впустую.

```bash
WEBHOOK_SECRET=$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2-)
glab api -X POST "projects/$P/hooks" \
  -f url=https://review-bot.example.com/webhook \
  -f token="$WEBHOOK_SECRET" \
  -F note_events=true -F push_events=false -F enable_ssl_verification=true | jq '{id, url, push_events, note_events}'
unset WEBHOOK_SECRET
```

То же руками: **Settings → Webhooks**, URL и Secret token как выше, галочка **Comments**, снять **Push events**.

## 3. Профиль в `service.yaml`

Проект без профиля бот игнорирует. Побеждает первый совпавший профиль, поэтому новый проект либо
дописывается в `projects` существующего профиля, либо получает свой профиль **выше** профилей
с более широким glob.

```yaml
profiles:
  - name: my-app
    projects: [my-group/my-app]          # glob: * — внутри сегмента, ** — любые сегменты
    connectors: [gitlab, linear]         # только из секции connectors
    issueKeys: { ABC: linear, "#": gitlab }
    related:
      - { project: my-group/my-docs, hint: Документация и API-контракты }
    relatedAllowlist: ["my-group/**"]    # что может добавить .review.yml репозитория
```

- **`issueKeys`** — без них ось постановки (`spec`, раздел «Постановка» общего ревью) не запускается.
  Префикс — ключ задачи (`ABC-137`), `"#"` — задачи GitLab (`#34`).
- **Где бот ищет задачу**: заголовок MR, строки `Closes/Fixes/Resolves/Refs` описания, аргумент
  `spec` и имя ветки. Из ветки номер задачи GitLab берётся, только если ветка **начинается** с него
  (`34-nick-change` — так её называет GitLab при создании из задачи). Ветки вида
  `feature/ido-none/130-…` задачу не дают — тогда нужен `Closes #130` в описании или `@codex_bot spec #130`.
- **`engines`** — какие боты отвечают в проекте; пусто — все настроенные.
- **`agentNetwork`**, **`cliTools`** — сеть у самого агента и CLI-утилиты с токенами. По умолчанию выкл.;
  это ослабление (README → «Безопасность»), включать осознанно.

## 4. Токены коннекторов

Коннектор видит ровно то, что видит его токен.

- **GitLab** (`GITLAB_MCP_TOKEN`, PAT бот-аккаунта со scope `read_api`) — после шага 1 новый проект
  виден, добавлять ничего не нужно.
- **Linear** — ключ ограничен командами, которые выбрали при его создании. Для задач другой команды
  либо пересоздайте ключ с этой командой, либо заведите отдельный коннектор (`linear-abc`) со своим
  токеном и подключите его только в нужном профиле. Ключ — только Read-only: у сервера есть пишущие
  инструменты.

Новый токен — в `.env`, в `service.yaml` на него ссылка `secret:NAME`. Ввести, не оставляя в истории
shell:

```bash
read -rs TOKEN && printf 'NAME=%s\n' "$TOKEN" >> .env && unset TOKEN
```

> **Ограничение.** Агенты всех джоб работают под одним пользователем ОС: агент джобы одного профиля
> может прочитать токены коннекторов и `cliTools` джобы другого профиля, если они идут одновременно.
> Пока изоляции джоб нет, держите в профилях токены одного уровня доверия — или поднимайте для
> команды отдельный экземпляр бота со своими `.env` и `service.yaml`.

## 5. Применить

```bash
docker compose up -d --force-recreate codex-bot
curl -s localhost:8080/healthz | jq
```

`--force-recreate` обязателен: содержимое примонтированного `service.yaml` не входит в хэш
конфигурации compose, и без флага при правке одного `service.yaml` контейнер останется старым.
`restart` не перечитывает и `.env`.

Ошибку в `service.yaml` (неизвестный ключ, открытый токен вместо `secret:NAME`, коннектор вне секции
`connectors`, коннектор в `issueKeys` без `prefetch`) сервис печатает при запуске — все сразу — и не
стартует: `docker compose logs codex-bot`. Какие профили загрузились, лог не показывает — что новый
профиль принят, видно только по прогону (шаг 6).

## 6. Проверить

Без публикации в MR — сухой прогон (README → «Сухой прогон»). Отчёт содержит код проекта и текст
задач — копируйте его только в `dry-run/` (он в `.gitignore`), не в корень репозитория:

```bash
docker exec mr-review-agent node dist/cli/dryRun.js \
  --project my-group/my-app --mr 12 --kind SPEC --out /tmp/dry-run/spec.md
mkdir -p dry-run && docker cp mr-review-agent:/tmp/dry-run/spec.md dry-run/
```

Проект вне профилей бот проигнорирует — в логе `webhook: ignored (no project profile)`.

Или вживую: `@codex_bot spec` в MR со ссылкой на задачу. Что смотреть в шапке заметки:

- **«Смежные репозитории: …»** — на каких ветках `related` шло ревью; есть всегда, если `related` задан.
- **«Открыто агентом: …»** — только если агент сам вызывал коннекторы. Прямые цели бот скачивает
  до запуска агента, и часто агенту больше ничего не нужно — тогда строки нет, и это не сбой.

## 7. `.review.yml` (по желанию, делает команда)

Файл в корне репозитория: `exclude`, `standards`, сужение `connectors`, дополнительные `related`
из `relatedAllowlist`. Формат — README → «`.review.yml` в репозитории». Бот читает его из защищённой
target-ветки или ветки по умолчанию, поэтому правка в самом MR действует только после мержа.
