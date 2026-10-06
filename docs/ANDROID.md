# Apps Холодосов — Android

## Как устроено (архитектура A)

```
Android-приложение (Capacitor, kz.greencity.fridgeops)
   └─ WebView без адресной строки → https://<ваш-домен>/m   ← интерфейс сотрудника
        └─ Apps Холодосов backend (Next.js API) → PostgreSQL
                                          → KitShop (ТОЛЬКО ЧТЕНИЕ, только с сервера)
```

- В APK **нет** бизнес-логики, данных и секретов — только адрес сервера и локальная страница «Нет связи».
- Веб, PWA и Android используют **один** бэкенд и **одну** базу. Телефон хранит только временный прогресс задачи (localStorage) до отправки.
- Почему не статическая сборка (`next export`): приложение держится на API routes, middleware (вход и роли), динамических страницах и серверном состоянии.
  Статический экспорт убрал бы бэкенд. Вариант B («статический фронт в APK + удалённый API») потребовал бы переписать загрузку данных, CORS и авторизацию
  на токены и выпускать APK при каждом изменении экранов. Вариант A безопаснее и проще для этого проекта.

### Что обновляется без нового APK

Всё, что приходит с сервера: экраны, тексты, логика миссий, движок рекомендаций, XP, аналитика — достаточно задеплоить сервер.

### Когда нужен новый APK

- изменился адрес сервера (`CAP_SERVER_URL`);
- добавлен/обновлён нативный плагин (push, камера/сканер);
- новые разрешения Android (камера, уведомления);
- иконка, сплэш, название, версия;
- требования Google Play (targetSdk и т. п.).

## Что нужно на компьютере

| Что | Зачем |
|---|---|
| Node.js 22+ | npm-скрипты |
| Android Studio (последняя) | SDK, эмулятор; внутри есть JDK (`jbr`) |
| JDK 21 | Gradle. Можно использовать JDK из Android Studio |

Windows (PowerShell), если Java не в PATH:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
```

## Адрес сервера

Всё приложение открывает `CAP_SERVER_URL` (обычно с путём `/m`). Он записывается в APK при `cap:sync`.

| Сценарий | CAP_SERVER_URL |
|---|---|
| Прод | `https://ops.example.kz/m` |
| Разработка в одной Wi-Fi сети | `http://192.168.1.50:3000/m` (IP компьютера с `start.bat`) |
| Эмулятор Android + локальный сервер | `http://10.0.2.2:3000/m` |

Для `http://` автоматически разрешается cleartext — **только** для разработки. Прод — всегда `https://`.

## Команды

### 1. Подготовить Android-проект (после любых изменений конфигурации)

```bash
# PowerShell:  $env:CAP_SERVER_URL="https://ops.example.kz/m"
# bash:        export CAP_SERVER_URL=https://ops.example.kz/m
npm run cap:sync
```

Делает: страницы `capacitor-www/` (запуск и «Нет связи») → `cap sync android` → иконки, сплэш, тёмная тема, версия из `package.json`.

### 2. Открыть в Android Studio

```bash
npm run cap:open
```

Кнопка ▶ Run ставит приложение на эмулятор или подключённый телефон.

### 3. Debug APK (для тестов на телефоне)

```bash
npm run android:debug
```

Файл: `android/app/build/outputs/apk/debug/app-debug.apk`.
Его же собирает CI на каждый push (артефакт `fridge-ops-debug-apk` в GitHub Actions).

### 4. Установить на реальный телефон

1. На телефоне: Настройки → О телефоне → 7 раз нажать «Номер сборки» → Для разработчиков → включить **Отладка по USB**.
2. Подключить USB, подтвердить доступ на телефоне.
3. Установить:

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`adb` лежит в `%LOCALAPPDATA%\Android\Sdk\platform-tools`. Без USB: отправить APK на телефон и открыть файл (разрешить «установку из неизвестных источников»).

### 5. Release AAB (Google Play) / release APK

Один раз создать ключ подписи и **хранить его вне репозитория** (потеря ключа = нельзя обновлять приложение в Play):

```bash
keytool -genkeypair -v -keystore fridge-ops-release.jks -alias fridgeops -keyalg RSA -keysize 2048 -validity 10000
```

Скопировать `android/keystore.properties.example` → `android/keystore.properties` и заполнить (файл и `.jks` в `.gitignore`).

```bash
# поднять версию: package.json "version" (1.1.0 → 1.2.0) — versionCode считается автоматически
npm run android:release
```

Файл: `android/app/build/outputs/bundle/release/app-release.aab` → загрузить в Google Play Console.
Для внутренней раздачи без Play: `node scripts/gradle.mjs assembleRelease` → `android/app/build/outputs/apk/release/app-release.apk`.

## Версии

- `versionName` = `version` из `package.json`;
- `versionCode` = MAJOR·10000 + MINOR·100 + PATCH (1.1.0 → 10100). Каждая новая сборка в Play должна иметь больший versionCode.

## Вход на телефоне

Сотрудник один раз вводит логин и PIN. Сессия хранится в httpOnly cookie WebView (до 180 дней, продлевается при использовании).
Администратор может отозвать сессию устройства: Настройки → Активные сессии → «Отозвать».

## Офлайн

- Отметки в чек-листе сохраняются на телефоне после каждого нажатия.
- «Готово» без связи попадает в очередь и отправляется при появлении сети или при возврате в приложение.
- Если сервер недоступен при запуске — показывается локальная страница «Нет связи» с кнопкой «Повторить».
- KitShop не затрагивается ни онлайн, ни офлайн.

## Push-уведомления (подготовлено, не включено)

Сервер уже генерирует важные события (`src/lib/server/notifications.ts`): «🔴 Сатти 2 может остаться без горячих блюд через 40 минут».
Правила строгие: только основные категории, реальный спрос, запас кончается в течение 45 минут, повтор не чаще раза в 2 часа, максимум 3 за анализ.
Сейчас они видны баннером в приложении и в логе сервера. Для настоящих push:

1. Firebase-проект → Android-приложение `kz.greencity.fridgeops` → `google-services.json` в `android/app/` (в git не коммитить).
2. `npm i @capacitor/push-notifications && npm run cap:sync` (новый APK).
3. В приложении: запросить разрешение, получить токен и отправить `POST /api/devices { platform: "android", token }` — эндпоинт уже есть.
4. На сервере: реализовать `FcmSender` (firebase-admin, ключ сервисного аккаунта в env `FCM_SERVICE_ACCOUNT_JSON`) и добавить в `senders`.

## Сканирование штрихкодов / QR (подготовлено)

- Каждая позиция маршрута уже приходит с `barcode`.
- `src/lib/client/scanner.ts`: `verifyScan(item, code)` → ✓ правильное блюдо / ⚠ «это другое блюдо: …»; интерфейс `Scanner` с веб-реализацией (BarcodeDetector).
- Для надёжного сканера в Android: плагин ML Kit для Capacitor + разрешение `CAMERA` → новый APK. Логику проверки менять не нужно.
