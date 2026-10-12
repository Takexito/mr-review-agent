# Деплой на VPS

Перенос бота с локального Mac на постоянный сервер. Мотив простой: сейчас вебхук жив ровно
столько, сколько включён ноутбук и не завис Docker Desktop.

Сервис к переезду готов по конструкции — bind-mount'ов с хоста нет, всё состояние в трёх
named volumes, GitLab публичный (`gitlab.com`). Переносить нужно три вещи: код, `.env` и
подписочный `auth.json`. Плюс туннель, который живёт вне Docker.

## Что переезжает, а что нет

| Что | Где сейчас | Как поступаем |
|---|---|---|
| **`auth.json`** — OAuth-сессия ChatGPT (`auth_mode: chatgpt`) | volume `codex-home` | Переносим. Самая хрупкая часть, см. «Грабли» |
| **`.env`** — `GITLAB_TOKEN`, `GITLAB_READ_TOKEN`, `LINEAR_API_KEY`, `WEBHOOK_SECRET` | рабочая копия, вне git | Копируем `scp`, не через git |
| **Креды cloudflared** — `<tunnel-uuid>.json` | `~/.cloudflared/` | Копируем. Hostname при этом **сохраняется** |
| **Код** | локальный git-репозиторий без remote | `rsync` (см. «Открытое») |
| `repos-cache` — bare-клоны, ~135 МБ | volume | **Не переносим**, склонируется заново при первой джобе |
| `redis-data` — очередь BullMQ, ~300 КБ | volume | **Не переносим**, там только следы отработанных и упавших джоб |
| Образ `mr-review-agent:latest`, 1.23 ГБ | локальный Docker | **Не переносим**, собирается на месте (другая арка) |

Про туннель отдельно: он *named* (`<tunnel-uuid>` →
`review-bot.example.com`), а не одноразовый `trycloudflare`. DNS-запись в Cloudflare
указывает на UUID туннеля, а не на конкретную машину, поэтому **URL вебхука в GitLab менять
не надо** — достаточно перенести файл кредов и поднять коннектор на новом хосте.

## Требования к VPS

- **Виртуализация KVM, не OpenVZ/LXC.** Это не вкусовщина: codex делает песочницу через
  `bubblewrap`, а тому нужны непривилегированные user namespaces. На контейнерных VPS их
  обычно нет — `bwrap` упадёт с «No permissions to create new namespace», и агент останется
  выполнять команды вообще без песочницы. Проверять **до** всего остального:

  ```bash
  unshare --user --map-root-user echo ok    # должно напечатать: ok
  ```

  Если вывода нет или ошибка — этот VPS не подходит, дальше можно не читать.

- **2+ vCPU, 4 ГБ RAM** (комфортно — 8 ГБ). При `QUEUE_CONCURRENCY=2` параллельно крутятся
  два `codex exec`, каждый со своим worktree и выкладкой доки.
- **~30 ГБ диска.** Образ 1.23 ГБ + build-кэш + `codex-home` (уже 0.5 ГБ: сессии, логи,
  sqlite-стейт) + кэш клонов, который растёт.
- Docker и docker compose.
- `cloudflared` (нативный пакет, не в контейнере).
- Linux/amd64 или arm64 — без разницы, образ собирается из исходников.

## Миграция

### 1. Снять с Mac

```bash
cd <рабочая-копия>

# сиат: забираем из живого контейнера
docker cp mr-review-agent:/data/codex/auth.json ./auth.json
```

### 2. Залить на VPS

```bash
rsync -av --exclude node_modules --exclude dist --exclude .git --exclude .env \
  ./ vps:/opt/mr-review-agent/

scp .env auth.json vps:/opt/mr-review-agent/
scp ~/.cloudflared/<tunnel-uuid>.json vps:/tmp/
```

Каталог на VPS назван `mr-review-agent` не случайно: compose берёт имя проекта из имени
каталога, а из него — префикс томов (`mr-review-agent_codex-home`). Другое имя каталога даст
другие тома, и команды из README перестанут совпадать.

`cert.pem` **не копируем**. Он нужен только для управления туннелями (создать, удалить,
привязать DNS) и является аккаунтным сертификатом Cloudflare; для `tunnel run` достаточно
JSON-файла кредов. Меньше секретов на сервере — лучше.

### 3. Погасить Mac — до старта VPS, не после

```bash
# на Mac
docker compose down
kill $(pgrep -f "cloudflared tunnel run mr-review-agent")
# если ставился через brew services: brew services stop cloudflared
```

Порядок здесь принципиален, обе половины по своей причине — см. «Грабли».

### 4. Поднять на VPS

```bash
ssh vps
cd /opt/mr-review-agent

# --- туннель ---
sudo mkdir -p /etc/cloudflared
sudo mv /tmp/<tunnel-uuid>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<tunnel-uuid>.json
sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: review-bot.example.com
    service: http://localhost:8080
  - service: http_status:404
EOF
sudo cloudflared service install     # systemd-юнит, подхватит /etc/cloudflared/config.yml
sudo systemctl enable --now cloudflared

# --- бот ---
docker compose up -d --build         # сборка из исходников, ~5-10 мин на первый раз

# --- сиат в volume ---
docker cp auth.json mr-review-agent:/data/codex/auth.json
rm auth.json                          # в рабочем каталоге ему делать нечего
docker compose restart codex-bot
```

### 5. Проверить

```bash
curl -s localhost:8080/healthz | jq                          # {"status":"ok",...}
curl -s https://review-bot.example.com/healthz | jq     # то же самое снаружи
docker compose logs -f codex-bot                             # ждём «mr-review-agent listening»
systemctl status cloudflared
```

`status: degraded` вместо `ok` — смотри, какая проверка в ответе не прошла:

- `engines.codex` — сиат: `auth.json` не доехал, лёг не туда или был инвалидирован при переносе;
- `gitlab.codexBot` / `clone` / `read` — истёк или неверен соответствующий токен в `.env`;
- `redis` — не поднялся контейнер Redis.

Проверки кэшируются (Codex — 5 минут, GitLab — 1 минута); после исправления пересоздай
контейнер (`docker compose up -d codex-bot`), чтобы увидеть новый статус сразу.

Проверка без следов в MR — сухой прогон (см. README, «Сухой прогон»). Боевая — тегнуть бота
в любом MR из `PROJECT_ALLOWLIST` и посмотреть, что в логах пройдёт полный цикл
`job queued → job started → diff ready → job done`. Первая джоба
будет заметно дольше обычного: bare-кэш пустой, репозиторий клонируется с нуля.

## Грабли

> **Ротация refresh-токена.** Codex при обновлении сессии ротирует `refresh_token` и
> инвалидирует предыдущий. Если `auth.json` окажется живым сразу на двух хостах, первый же
> рефреш на одном из них разлогинит другой — молча, до ближайшей джобы. Отсюда требование
> гасить Mac **до** старта VPS. По той же причине бэкап `auth.json` почти бесполезен: копия
> протухает при первой же ротации, и восстанавливаться из неё нечем. Планируй не бэкап, а
> перелогин.

> **Два коннектора одного туннеля.** cloudflared умеет HA-реплики: если туннель поднят и на
> Mac, и на VPS, Cloudflare начнёт балансировать вебхуки между ними. Получишь два бота на
> одном сиате, дублирующиеся ревью в MR и ту самую ротацию токена из предыдущего абзаца.
> Второй коннектор гасим явно, а не «ну он там вроде спит».

> **Смена IP и гео.** Перенос сессии подписки на серверный IP в другой стране OpenAI может
> счесть подозрительным. Держи под рукой возможность перелогиниться на VPS
> (`codex login`, headless-флоу или проброс порта по SSH) — на случай, если перенесённый
> `auth.json` не примут.

> **Не переноси образ.** `docker save` / `docker load` с arm64-Mac на amd64-VPS даст образ,
> который не запустится. Dockerfile ставит всё из npm и apt, поэтому правильный путь —
> `docker compose build` на месте.

> **ToS и лимиты.** Не новое, но на постоянно работающем сервере обостряется: подписка в
> автоматизации — серая зона ToS OpenAI, а лимиты Codex делятся с живым разработчиком, чей
> сиат переиспользован. Круглосуточный бот выбирает их заметнее, чем ноутбук, включённый
> днём.

## Откат

Обратно на Mac — симметрично и быстро:

```bash
# на VPS
docker compose down && sudo systemctl stop cloudflared

# на Mac
open -a Docker && docker compose up -d
cloudflared tunnel run mr-review-agent
```

Туннель перецепится сам, DNS и URL вебхука не меняются. Незаконченные джобы потеряются —
они живут в Redis, который мы не переносим; их достаточно перевызвать тегом в MR.

## Эксплуатация

**Обновление кода** — тем же `rsync` с пересборкой:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .env ./ vps:/opt/mr-review-agent/
ssh vps 'cd /opt/mr-review-agent && docker compose up -d --build'
```

**Что бэкапить.** Практически — только `.env` и креды туннеля, оба статичные. `auth.json`
бэкапу не поддаётся (см. «Грабли»), `repos-cache` и `redis-data` расходные, образ
воспроизводится из исходников.

**Рост диска.** `codex-home` копит сессии и логи, `repos-cache` — клоны. Смотреть
`docker system df -v`; чистить кэш клонов можно без последствий:

```bash
docker compose down && docker volume rm mr-review-agent_repos-cache && docker compose up -d
```

**Ротация сиата** — как в README: перезалить свежий `auth.json` через `docker cp` и
перезапустить `codex-bot`.

## Открытое

- **У репозитория нет remote.** Локальный git заведён (первый коммит — 2026-10-12), но код
  никуда не запушен: доставка на сервер пока только `rsync` рабочей копии, а единственная
  копия истории лежит на ноутбуке. Стоит запушить в GitLab и деплоить `git pull`.
- **GitLab-токены текущей установки истекают 2026-12-31** (`codex_bot_api` и `read_codex_bot`).
- **`LINEAR_API_KEY` текущей установки — от пространства Acme**, а задачи `android-app`
  (`OPS-…`) живут в другом: в `spec` они приходят как «не найдена в Linear».
- **Сиат в контейнере общий с локальным codex разработчика** (скопирован с хоста 2026-10-11) —
  см. «Ротация refresh-токена» выше; при переезде лучше отдельный `codex login`.
- CI/CD не настраивается — деплой ручной.
- Мониторинг за пределами `/healthz` и `restart: unless-stopped` не предусмотрен: если сиат
  разлогинится, узнаешь об этом из молчания бота в MR.
