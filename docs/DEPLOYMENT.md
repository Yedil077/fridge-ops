# Apps Холодосов — production

Цель: сотрудникам не нужны одна Wi-Fi сеть, `start.bat` и включённый компьютер в офисе. Сервер работает круглосуточно по HTTPS.

## Схема

```
Телефоны (Android app / PWA)  ─┐
Компьютеры (браузер)          ─┼─ HTTPS ─▶ Caddy (сертификат Let's Encrypt)
                               │              └─▶ Apps Холодосов (Next.js, Docker) ─▶ PostgreSQL (Docker volume)
                               │                          └─▶ KitShop API (ТОЛЬКО ЧТЕНИЕ)
```

- **Один экземпляр приложения** на базу. Состояние хранится в PostgreSQL как версионированный документ, запись защищена проверкой версии:
  второй экземпляр не сможет затереть данные первого, а получит ошибку. Для 15 холодильников и десятков сотрудников этого с запасом хватает.
  Нормализованная модель для роста описана в `prisma/schema.prisma`.
- Секреты только в `.env.production` **на сервере**.

## Что понадобится

- VPS: 2 vCPU, 2–4 ГБ RAM, 20 ГБ диска, Ubuntu 22.04/24.04 (подойдёт любой провайдер, в том числе в Казахстане), публичный IP.
- Домен, например `ops.greencity.kz`, с A-записью на IP сервера.
- Docker + Docker Compose на сервере.

## Развёртывание (Docker Compose)

```bash
# на сервере
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone <repo-url> /opt/fridge-ops && cd /opt/fridge-ops
cp deploy/.env.production.example .env.production
nano .env.production        # DOMAIN, POSTGRES_PASSWORD, AUTH_SECRET, ADMIN_PIN …
docker compose --env-file .env.production up -d --build
docker compose logs -f app  # «created initial accounts: admin»
```

Проверка: `https://<DOMAIN>/api/health` → `{"ok":true,"store":"postgres",…}`.

Генерация секретов:

```bash
openssl rand -base64 48   # AUTH_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD
```

## Обновление

```bash
cd /opt/fridge-ops
git pull
docker compose --env-file .env.production up -d --build
```

Android-приложение обновлять не нужно: оно открывает этот сервер (см. docs/ANDROID.md).

## Резервные копии

```bash
chmod +x deploy/backup.sh
crontab -e   # 0 3 * * * /opt/fridge-ops/deploy/backup.sh
```

Копии: `backups/fridgeops-YYYY-MM-DD.sql.gz`, 14 дней. Дополнительно приложение хранит снимок каждые 50 записей в `fridge_ops_state_history`.
Восстановление: `gunzip -c backups/fridgeops-….sql.gz | docker compose exec -T db psql -U fridgeops -d fridgeops`.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `DOMAIN` | домен для HTTPS |
| `POSTGRES_PASSWORD` | пароль базы (compose собирает из него `DATABASE_URL`) |
| `AUTH_SECRET` | подпись служебной cookie роли; обязателен |
| `ADMIN_LOGIN`, `ADMIN_PIN`, `ADMIN_NAME` | первый администратор (создаётся один раз, если пользователей нет) |
| `DATA_SOURCE` | `mock` (пилот на симуляторе) или `kitshop` |
| `SIM_REALTIME` | по умолчанию часы симулятора идут по реальному времени; `false` — остановить часы (для тестов) |
| `APP_TIMEZONE` | часовой пояс холодильников, например `Asia/Almaty` |
| `KITSHOP_*` | только сервер, только чтение; пока `KITSHOP_ENABLED=false` |

## Без Docker (PaaS)

Подойдёт любой хостинг Node.js 22 + управляемый PostgreSQL:
`npm ci && npm run build && npm run start`, переменные `STORE_DRIVER=postgres`, `DATABASE_URL`, `AUTH_SECRET`, `ADMIN_*`, `NODE_ENV=production`.
Обязательно одно работающее приложение (без автомасштабирования на несколько экземпляров) и HTTPS.

## Бесплатно для пилота

Условия бесплатных тарифов часто меняются, поэтому перед регистрацией сверьтесь с сайтом провайдера.

### Вариант 1 — Render + Neon (проще всего, без своего сервера)

1. **База:** зарегистрироваться на neon.tech → создать проект → скопировать connection string (`postgres://…?sslmode=require`).
2. **Приложение:** render.com → New → **Blueprint** → выбрать репозиторий `fridge-ops` (файл `render.yaml` уже в репозитории).
3. В Render ввести `DATABASE_URL` (строка из Neon) и `ADMIN_PIN` (4–8 цифр). `AUTH_SECRET` сгенерируется сам.
4. Через несколько минут приложение будет на `https://fridge-ops-xxxx.onrender.com` (HTTPS уже есть).
   Проверка: `/api/health` → `"store":"postgres"`.
5. Android: `CAP_SERVER_URL=https://fridge-ops-xxxx.onrender.com/m npm run cap:sync`.

Ограничение бесплатного Render: после ~15 минут без запросов сервис засыпает, и первое открытие занимает 30–60 секунд.
Для демонстрации и пилота это нормально, для ежедневной работы — перейти на платный тариф (~7 $/мес) или на вариант 2.

### Вариант 2 — Oracle Cloud Always Free (настоящий сервер, бесплатно постоянно)

Бесплатная виртуальная машина (ARM, до 4 ядер и 24 ГБ памяти), не засыпает. При регистрации нужна банковская карта для проверки.
На машине — обычная установка из раздела «Развёртывание (Docker Compose)» выше: Docker, PostgreSQL и HTTPS на одном сервере.
Нужен домен (или бесплатный поддомен, например от DuckDNS) с A-записью на IP машины.

### Пробные периоды

Google Cloud, Azure, DigitalOcean и Railway дают стартовые кредиты или пробный период. Подходят для теста на 1–3 месяца, потом платно.
Недорогой постоянный вариант — VPS у местного провайдера (1–2 ГБ RAM достаточно).

### Что НЕ подходит

Vercel, Netlify и другие serverless-хостинги: приложение держит состояние в одном постоянно работающем процессе
(симулятор, кеш анализа, единый документ в базе), а serverless запускает много короткоживущих копий. Нужен обычный постоянный сервер или контейнер.

## Фоновые задачи

Часовой анализ запускается автоматически при первом обращении после истечения часа, отдельный cron не нужен.
При подключении KitShop понадобится фоновая синхронизация (`src/lib/sync/syncEngine.ts`) — её можно запускать по расписанию через `instrumentation.ts` или системный cron.
