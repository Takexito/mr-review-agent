# Деплой на сервер

Как держать бота на постоянном сервере (VPS), а не на рабочей машине. Быстрый старт и настройка —
в [README](README.md); здесь — требования к хосту, публикация вебхука, перенос сиата и грабли.

Всё состояние сервиса — в трёх named volumes, bind-mount'ов с хоста нет, кроме `service.yaml`.
На сервер нужны четыре вещи: код, `service.yaml`, `.env` и подписочный `auth.json`. Плюс туннель
или reverse-proxy, который живёт вне Docker.

## Что где лежит

| Что | Где | Как поступаем |
|---|---|---|
| **`auth.json`** — OAuth-сессия ChatGPT (`auth_mode: chatgpt`) | volume `codex-home` | Кладём `docker cp`. Самая хрупкая часть, см. «Грабли» |
| **`.env`** — `GITLAB_TOKEN`, токены коннекторов, `WEBHOOK_SECRET` | рабочий каталог, вне git | Копируем `scp`, не через git |
| **`service.yaml`** — движки, бот-аккаунты, профили проектов; секретов нет | рабочий каталог, вне git | Копируем вместе с кодом |
| **Креды туннеля** (если cloudflared) — `<tunnel-uuid>.json` | `~/.cloudflared/` | Копируем; hostname сохраняется |
| `repos-cache` — bare-клоны | volume | Расходный: склонируется заново при первой джобе |
| `redis-data` — очередь BullMQ | volume | Расходный: только следы отработанных и упавших джоб |
| Образ | Docker | Собирается на месте из исходников |

## Требования к серверу

- **Виртуализация KVM, не OpenVZ/LXC.** Codex делает песочницу через `bubblewrap`, а тому нужны
  непривилегированные user namespaces. На контейнерных VPS их обычно нет — `bwrap` упадёт с
  «No permissions to create new namespace», и агент останется выполнять команды вообще без
  песочницы. Проверять **до** всего остального:

  ```bash
  unshare --user --map-root-user echo ok    # должно напечатать: ok
  ```

- **2+ vCPU, 4 ГБ RAM** (комфортно — 8 ГБ). При `server.queueConcurrency: 2` параллельно идут
  два прогона агента, каждый со своим worktree и чекаутами смежных репозиториев.
- **~30 ГБ диска**: образ (~1.2 ГБ), build-кэш, `codex-home` (сессии, логи) и растущий кэш клонов.
- Docker и docker compose.
- Туннель или reverse-proxy с TLS для вебхука (ниже — вариант с cloudflared).
- Linux/amd64 или arm64 — без разницы, образ собирается из исходников.

## Установка

```bash
git clone <url-репозитория> /opt/mr-review-agent
cd /opt/mr-review-agent
cp service.example.yaml service.yaml   # движки, бот-аккаунты, профили
cp .env.example .env                   # секреты; chmod 600 .env
docker compose up -d --build           # первая сборка — 5–10 минут

# сиат подписки в volume
docker cp auth.json mr-review-agent:/data/codex/auth.json
rm auth.json
docker compose restart codex-bot
```

Каталог назван `mr-review-agent` не случайно: compose берёт имя проекта из имени каталога, а из
него — префикс томов (`mr-review-agent_codex-home`). Другое имя каталога даст другие тома, и
команды из README перестанут совпадать.

### Вебхук через named-туннель cloudflared

Порт бота слушается только на `127.0.0.1:8080`. Постоянный адрес даёт named-туннель (DNS-запись
указывает на UUID туннеля, а не на машину, поэтому при переезде URL вебхука в GitLab не меняется):

```bash
# один раз, на машине с аккаунтом Cloudflare
cloudflared tunnel create mr-review-agent
cloudflared tunnel route dns mr-review-agent review-bot.example.com

# на сервере
sudo mkdir -p /etc/cloudflared
sudo mv <tunnel-uuid>.json /etc/cloudflared/ && sudo chmod 600 /etc/cloudflared/<tunnel-uuid>.json
sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: review-bot.example.com
    path: ^/webhook$
    service: http://localhost:8080
  - service: http_status:404
EOF
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

`path: ^/webhook$` отдаёт наружу только вебхук: `/healthz` раскрывает состояние токенов и
остаётся на localhost. `cert.pem` на сервер **не копируем** — он нужен только для управления
туннелями; для `tunnel run` достаточно JSON-файла кредов.

## Проверка

```bash
curl -s localhost:8080/healthz | jq          # {"status":"ok",...}
docker compose logs -f codex-bot             # ждём «mr-review-agent listening»
```

`status: degraded` вместо `ok` — смотри, какая проверка в ответе не прошла:

- `engines.codex` — сиат: `auth.json` не доехал, лёг не туда или был инвалидирован;
- `gitlab.codexBot` / `clone` / `read` — истёк или неверен соответствующий токен в `.env`;
- `redis` — не поднялся контейнер Redis.

Проверки кэшируются (Codex — 5 минут, GitLab — 1 минута); после исправления пересоздай
контейнер (`docker compose up -d codex-bot`), чтобы увидеть новый статус сразу.

Проверка без следов в MR — сухой прогон (README → «Сухой прогон»). Боевая — тегнуть бота в MR
проекта из профилей `service.yaml` и проверить, что в логах прошёл цикл
`job queued → job started → diff ready → job done`. Первая джоба дольше обычного: кэш клонов пуст.

## Грабли

> **Ротация refresh-токена.** Codex при обновлении сессии ротирует `refresh_token` и
> инвалидирует предыдущий. Если один `auth.json` живёт сразу на двух хостах, первый же рефреш на
> одном из них разлогинит другой — молча, до ближайшей джобы. При переезде гаси старый экземпляр
> **до** старта нового. Бэкап `auth.json` почти бесполезен: копия протухает при первой ротации.
> Надёжнее отдельный `codex login` для бота.

> **Два коннектора одного туннеля.** cloudflared умеет HA-реплики: если туннель поднят на двух
> машинах, Cloudflare будет балансировать вебхуки между ними — два бота на одном сиате,
> дублирующиеся ревью и ротация токена из предыдущего абзаца. Второй коннектор гаси явно.

> **Смена IP и гео.** Перенос сессии подписки на серверный IP в другой стране провайдер может
> счесть подозрительным. Держи под рукой возможность перелогиниться на сервере (`codex login`,
> headless-флоу или проброс порта по SSH).

> **Не переноси образ между архитектурами.** `docker save` / `docker load` с arm64 на amd64 даст
> образ, который не запустится. Собирай на месте: `docker compose build`.

> **Подписка и лимиты.** Круглосуточный бот выбирает лимиты подписки заметнее, чем человек.
> Об условиях использования — README, «Подписки и условия провайдеров».

## Эксплуатация

**Обновление кода:**

```bash
cd /opt/mr-review-agent && git pull && docker compose up -d --build
```

**Что бэкапить.** Только `.env`, `service.yaml` и креды туннеля. `auth.json` бэкапу не поддаётся
(см. «Грабли»), `repos-cache` и `redis-data` расходные, образ воспроизводится из исходников.

**Рост диска.** `codex-home` копит сессии и логи, `repos-cache` — клоны. Смотреть
`docker system df -v`; кэш клонов чистится без последствий:

```bash
docker compose down && docker volume rm mr-review-agent_repos-cache && docker compose up -d
```

**Ротация сиата** — перезалить свежий `auth.json` через `docker cp` и перезапустить `codex-bot`.

**Мониторинг.** За пределами `/healthz` и `restart: unless-stopped` не предусмотрен: если сиат
разлогинится, `/healthz` уйдёт в `degraded`, а бот в MR ответит ошибкой.
