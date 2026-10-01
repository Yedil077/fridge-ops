# KiT Shop write API audit (Phase A)

Source: the official documentation **«Kit Shop API», version 1.3** (https://kitshop.ru/Download/API.pdf,
linked from https://kitshop.ru/Public/API). Everything below comes from that document. **No request
was sent to the production API during this audit.** Endpoints that are not in the document are
listed as "not found". None were invented.

"Supported by our account" means one thing here: we have **not checked it yet**. Every write method
needs a KiT Shop user with **«API»** rights. Whether that user may perform a specific operation is
only known after a real call (`ResultCode 13 = "no rights for the operation"`). The checks are
planned in Phase D, on one test shop and one test product.

## 1. Common protocol (all methods)

| Item | Value (from the docs) |
|---|---|
| Base URL | `https://api.kitshop.ru/APIService.svc/{Method}` |
| HTTP method | **POST** for every method, JSON body, UTF-8 |
| Auth | Body object `Auth { CompanyId Int32, RequestId Int64, UserLogin string, Sign string }` |
| Sign | `MD5(CompanyId + Password + RequestId)` as a hex string. The docs show both upper- and lower-case examples. **Case is not verified yet.** |
| RequestId | Must be **greater than in the previous request** for this user. The docs suggest a date/time number. |
| Filter | `UpDate`/`ToDate` in `dd.MM.yyyy HH:mm:ss`, plus optional `ShopId`/`DeviceId`/`CompanyId`. The period is at most 60 days (`ResultCode 30`). |
| Response | `{ ResultCode Int32, ErrorMessage?, Response?, …data }` |
| Result codes | 0 OK, 1 unknown error, 2 bad JSON, 9 company not found, 10 company blocked, 11 user not found, 12 user blocked, **13 no rights**, **14 bad RequestId**, **15 bad Sign**, 28 required fields missing, 30 period > 60 days, 42 bad CommandCode, 51 DeviceId not in shop, 61 bad image hex, 100 operation not performed / nothing found |

### Protocol risks and our mitigations

* **RequestId must increase.** The `ddMMyyyyHHmmss` example from the docs does **not** increase
  across days (01.10 < 30.09). It also repeats within one second.
  → We use `yyMMddHHmmssfff` (the format of the docs' own JSON examples, e.g. `210624131945394`).
  We force it to be strictly greater than the last value. Requests run **one at a time** through a
  single queue on the server. With parallel requests the order of arrival is not guaranteed, and
  that gives `ResultCode 14`.
* Only **one backend instance** may talk to KiT Shop with a given login. Two instances would race
  on RequestId. Render already runs a single instance.
* **Credentials** (`KITSHOP_COMPANY_ID`, `KITSHOP_LOGIN`, `KITSHOP_PASSWORD`) exist only in server
  env. They are never in the APK, the browser bundle, localStorage or Git. The password is used only
  to compute `Sign` and is never logged.

## 2. Write operations we need

### 2.1 LOAD / UNLOAD: `MakeFillUp` (docs §3.21) ✅ documented

| | |
|---|---|
| Endpoint | `POST /MakeFillUp` |
| Params | `ShopId` Int32 **M**; `Notes` string O; `FillUps[]` **M**: `{ ProductId Int64 M, Fillup Int32 M, ExpiryDate "dd.MM.yyyy HH:mm:ss" O }` |
| Sign of `Fillup` | **positive = load, negative = unload**. One call can mix both (FillupType 3 "mixed"). |
| Response | `{ "ResultCode": 0, "Response": "Успешное загрузка товаров" }`. **No fill-up id is returned.** |
| Errors | `100`: shop not found **or** stock is not tracked for this shop (`StocksAccounting = 0`); auth codes 9–15; 28 |
| Permissions | API user. The specific right is unknown (13 if missing). |
| Our account | **Unverified** |

**Risks**

1. **No idempotency key.** The API cannot tell a retry from a new operation. A blind retry after a
   lost response **would load the goods twice**.
   → Every operation gets our `operation_uuid`, and we put it into `Notes`
   (`FO:<uuid> …`). After a timeout or a lost response the operation becomes **UNKNOWN** and is
   **never re-sent automatically**. We check it through read methods (see 2.2). We re-send only
   when the check proves the operation is absent.
2. Partial success inside one call is not documented. We assume all-or-nothing and verify through
   `GetFillUpById.Details`.
3. Quantities are Int32 in the request, but stock is Decimal. We only send whole units.
4. `ShopId` must be the stable KiT Shop id (e.g. 621583), never a name.

### 2.2 Verification of a write: `GetFillUps` (§3.19) + `GetFillUpById` (§3.12) ✅ documented (read)

* `GetFillUps`: `Filter { UpDate, ToDate (≤ 60 d), ShopId?, DeviceId?, UserId?, FillupType?, FillupSource? }`
  → `FillUps[{ FillupId, ShopId, FillupType, FillupSource, DeviceId, FillupDateTime, UserId, UserName, Notes }]`.
* `GetFillUpById`: `Id` → the same plus `Details[{ DetailId, ProductId, Quantity (signed Decimal), ExpiryDate }]`.
* Verification algorithm: list fill-ups of the shop around the send time, find
  `Notes` containing `FO:<uuid>`, then compare `Details` with what we sent.
  Found → CONFIRMED (record `FillupId`). Not found after the window → safe to mark FAILED and allow
  a manual re-send.
* **Risk:** we have not verified that `Notes` sent through `MakeFillUp` is returned unchanged in
  `GetFillUps`. Phase D test #1 checks this. Until then UNKNOWN operations go to
  **REQUIRES_REVIEW** (a manager checks the KiT Shop cabinet).

### 2.3 Stock after a write: `GetShopStocks` (§3.20) ✅ documented (read)

`Id` (shop) → `Stocks[{ ProductId, ProductName, UnitType, Barcode?, VendorCode?, Quantity Decimal, ExpiryDate? }]`.
`ResultCode 100` means shop not found, stock not tracked, **or empty stock**. An empty fridge is
not an error. We refresh it right after each confirmed write.

### 2.4 WRITE-OFF ❌ not found

The documentation has **no write-off method**. FillupType has only 1 load, 2 unload, 3 mixed.
The other write methods do not cover it either. Options:

* (a) a write-off is recorded as an **UNLOAD** in KiT Shop (`Fillup < 0`, `Notes = "FO:<uuid> СПИСАНИЕ: <reason>"`)
  plus our own write-off record with the reason, for waste analytics;
* (b) write-offs stay local only until KiT Shop provides a method.

**We do not fake a write-off endpoint.** In the app WRITE-OFF is implemented as (a). It is shown as
"Списание (в KiT Shop как разгрузка)" and needs confirmation from the business before Phase E.

### 2.5 Product catalog

| Need | Method | Status | Notes |
|---|---|---|---|
| Create product (company catalog) | `AddProduct` §3.16 | ✅ | M: `ProductName`, `UnitType` (App. 6), `TaxType` (App. 3), `AccuracyType` (App. 7). O: Price, CostPrice, GroupId, Barcode, VendorCode, ProductImage (hex), ProductDescription, Weight, AccuracyValue. Response `{ResultCode:0, Id}`. **Not idempotent:** a retry creates a duplicate. → ADMIN only, preview + confirmation. After a lost response we search `GetProducts` by barcode/vendor code before any retry. |
| Update product | `EditProduct` §3.17 | ✅ | M: `ProductId`, then any subset of the fields above. Idempotent by nature. Note: the docs' JSON example omits `ProductId` and uses an undocumented `CostPriceString` field. We follow the field table, not the example. |
| Delete product | `DeleteProduct` §3.18 | ✅ exists | `Id`. **We will not call it.** "Deactivate" is local only (spec: never auto-delete from KiT Shop). |
| Find product | `GetProducts` §3.3 / `GetProductById` §3.7 | ✅ read | Fields: ProductId, ProductName, Barcode, VendorCode, ShortCodes, GroupId, Price… Used for mapping (id → barcode → vendor code; a name is only a suggestion). |
| Add product to a shop's product base | `AddProductToProductBaseTemplate` §3.33 | ✅ | M: `TemplateId`, `ProductId`, `Price`, `Disabled`, `CategoryId`, `LocationId`; O: `LocationAddress`. **A template can be shared by several shops.** Adding to a template may affect every shop linked to it. |
| List a shop's product base | `GetProductBaseTemplate` §3.32 | ✅ read | `Id` = template id. The docs say it comes from the shop's `ProductBaseTemplateId`. **That field is not listed in the GetShops/GetShopById response tables**, so we must check it against a real response. |
| Remove from product base | `RemoveProductFromProductBaseTemplate` §3.34 | ✅ exists | We will not use it automatically. |
| Response format for §3.32–3.34 | — | ⚠ | The docs give only the request structure for these three methods, without response examples. **Unverified.** |
| Meaning of `CategoryId` / `LocationId` | — | ⚠ | Not explained in the docs (no list method found for them). **Unverified.** |
| Push product base to the terminal | `AddCommand` code 2 «Загрузить базу товаров» | ✅ | Probably needed after a template change. Unverified. |

Because of the ⚠ items, **"Add to shop base" stays disabled even in the mock UI flow for real
shops** until Phase D checks it on one test shop and its template.

### 2.6 Equipment / locks: `AddCommand` (§3.31) ✅ documented, ⛔ not implemented

`Command { ShopId Int32 M, DeviceId Int64 O (all devices if omitted), CommandCode Int32 M }`,
where code **12 = «Открыть замки»** (open locks). Other codes: 1 software update, 2 load product
base, 4 restart software, 5 restart terminal, 6 hard reboot, 7 rollback, 8 stop terminal,
9 start, 10 shut down, 11 send logs.

* Risks: omitting `DeviceId` sends the command to **every** device in the shop. Codes 6, 8 and 10
  can take a fridge out of service. Opening locks is a physical-security action.
* Required before implementation (spec §36): a verified endpoint ✅, verified permissions ❌,
  confirmation UX ❌, audit log (built in Phase B). **Status: not implemented.**
  The future UI will offer only code 12 with an explicit `DeviceId`, for ADMIN/MANAGER only, with
  a double confirmation.

## 3. Read endpoints used by the live sync (for completeness)

`CheckAuth`, `GetShops`, `GetShopById`, `GetDevices`, `GetProducts`, `GetProductGroups`,
`GetShopStocks`, `GetSales` (Filter, ≤ 60 d), `GetSalesByShops/Devices/Products/Days`,
`GetFillUps`, `GetFillUpById`, `GetMonitoring`. All are POST with `Auth`.
Our old client assumed GET, which was **wrong**. It is now replaced by the POST transport.

## 4. Gate configuration

| Env | Default | Meaning |
|---|---|---|
| `KITSHOP_ENABLED` | `false` | allows any network call to KiT Shop (reads) |
| `KITSHOP_WRITE_ENABLED` | `false` | allows write operations to leave our server |
| `KITSHOP_WRITE_DRY_RUN` | `true` | logs the exact body that **would** be sent (without Auth); no network call |
| `KITSHOP_WRITE_SHOPS` | *(empty)* | comma-separated KiT Shop ShopIds allowed for real writes. Empty = none. We never enable all fridges at once. |

A real write needs `KITSHOP_ENABLED=true`, `KITSHOP_WRITE_ENABLED=true`, `KITSHOP_WRITE_DRY_RUN=false`
**and** the shop in `KITSHOP_WRITE_SHOPS`. Otherwise the request goes to the mock adapter or the
dry-run adapter.

## 5. Phase D checklist (one test shop, one test product)

1. `CheckAuth` → 0, which also checks the case of `Sign`.
2. `GetShops`: check `StocksAccounting` for the test shop and whether `ProductBaseTemplateId` is present.
3. `MakeFillUp` +1 of the test product with `Notes = "FO:<uuid> TEST"`.
4. `GetFillUps` for the last 10 min: is the note returned unchanged? Then `GetFillUpById` for the Details.
5. `GetShopStocks`: is the quantity +1?
6. `MakeFillUp` −1 (unload back) and repeat steps 4–5.
7. Record each ResultCode in this document. Only then add the shop to `KITSHOP_WRITE_SHOPS`.

## 6. Notes for the live sync

* `GetSales` returns receipts **without items** (`SaleId`, `ShopId`, `DeviceId`, `SaleDateTime`, `Sum`…).
  Product-level history needs `GetSaleById` per receipt or the aggregated `GetSalesByProducts`.
  Both work in ≤ 60-day windows. The 5-minute live sync therefore pulls `GetShopStocks` per shop and new receipts.
  Product lines are added incrementally and stored in our PostgreSQL.
* `GetShopStocks` takes **one** shop `Id`, so 15 fridges need 15 calls, run one after another (RequestId order).

## 7. Implementation status (Phase B, mock adapter)

| Spec item | Where | Status |
|---|---|---|
| Transport POST + Auth/Sign, increasing RequestId, serialized | `src/services/kitshop/transport.ts` | ✅ unit-tested with a fake fetch, never called against production |
| Read client (documented methods only) | `src/services/kitshop/kitshopClient.ts` | ✅ gated by `KITSHOP_ENABLED` |
| Write gate + adapters (mock / dry-run / live) | `src/lib/server/kitshopWrite.ts`, `src/lib/kitshop-ops/adapters.ts`, `src/services/kitshop/writer.ts` | ✅ live = MakeFillUp + AddProduct only |
| Operations journal, statuses, idempotency, verification, audit | `src/lib/kitshop-ops/service.ts` | ✅ 16 scenario tests (`tests/kitshopOps.test.ts`) |
| Mission → TRANSFER (source UNLOAD + target LOAD) | `Runtime.startTransfer` | ✅ the LOAD waits for the UNLOAD; PARTIAL is shown |
| Product mapping + catalog health | `src/lib/kitshop-ops/mapping.ts`, `/admin/products` | ✅ |
| Create in KiT Shop (ADMIN, preview) | `/admin/products` → `AddProduct` | ✅ mock / dry-run; live only through the gate |
| Add to a shop's product base | §3.33 | ⏸ waits for Phase D (template id and response format unverified) |
| LOAD / UNLOAD / WRITE-OFF screen, camera scan, rapid mode, search | `/m/scan` | ✅ |
| СИНХРОНИЗАЦИЯ screen | `/m/sync` | ✅ verify / re-send / manual decision (manager) |
| Stock screen: last sync + ОБНОВИТЬ | `/m/fridges/[id]`, `/m/scan` | ✅ (MOCK stock is live; real stock waits for the KiT Shop data source) |
| Lock control | — | ⛔ not implemented (see §2.6) |
| Availability / SATTI / shop-to-shop analytics | — | next step (needs real sales lines) |

## 8. Production readiness audit (before Phase D)

| Item | Finding | Fix |
|---|---|---|
| Auth / Sign | MD5(CompanyId+Password+RequestId); case not documented | `KITSHOP_SIGN_CASE`; ПРОВЕРИТЬ СОЕДИНЕНИЕ probes the other case on ResultCode 15 (CheckAuth is read-only) and tells which to set |
| RequestId | each transport instance had its own sequence → reads and writes could collide (ResultCode 14) | **one transport per process** shared by reader + writer; still `yyMMddHHmmssfff`, strictly increasing, serialized |
| RequestId across instances | Render zero-downtime deploys briefly run 2 instances | don't run the write test during a deploy |
| MakeFillUp gate | a closed gate threw → operation became UNKNOWN | now a definite "not sent" rejection (FAILED, never UNKNOWN) |
| Crash between send and save | the PENDING record was saved asynchronously | a LIVE write is **persisted (awaited) before** it leaves the server |
| Live writes scope | an allowlisted shop received live writes from every screen and mission | `KITSHOP_WRITE_SCOPE=test` (default): only the admin REAL WRITE TEST writes live; everything else on that shop → dry-run |
| UNKNOWN reconciliation | absent UUID could become FAILED for live after a window | LIVE: found in GetFillUps → CONFIRMED, not found → **REQUIRES_REVIEW**; never re-sent automatically |
| GetFillUps window | ±10/60 min, KiT Shop timezone undocumented | ±6 h around the send time |
| Late answer | ignored once an op was REQUIRES_REVIEW | accepted for UNKNOWN and REQUIRES_REVIEW |
| Operation timestamps | simulator clock (could be ahead after DEV "+1 h") | real wall-clock time |
| Duplicate protection | by operation_uuid | ✓ (checked again by the wizard) |
| Timeout | 10 s → UNKNOWN, transport keeps 15 s for a late answer | ✓ |
| Audit log | create/result/verify/retry/resolve + pause/resume, test shop/product, connection checks | ✓ |
| Dry-run | logs body without Auth, sends nothing | ✓ |
| Emergency stop | — | **PAUSE ALL WRITES** (database flag): every LOAD/UNLOAD/WRITE-OFF/AddProduct is blocked before any adapter; reads keep working |

## 9. Phase D procedure (`/admin/kitshop/diagnostics`)

1. Render → Environment: `KITSHOP_ENABLED=true`, `KITSHOP_COMPANY_ID`, `KITSHOP_LOGIN`, `KITSHOP_PASSWORD` (API user), keep `KITSHOP_WRITE_ENABLED=false`. Deploy.
2. ПРОВЕРИТЬ СОЕДИНЕНИЕ → CONNECTED (set `KITSHOP_SIGN_CASE` if the page asks).
3. Choose TEST SHOP and TEST PRODUCT (stock is read from GetShopStocks).
4. Only then: `KITSHOP_WRITE_ENABLED=true`, `KITSHOP_WRITE_DRY_RUN=false`, `KITSHOP_WRITE_SHOPS=<that one ShopId>`, `KITSHOP_WRITE_SCOPE=test`. Deploy.
5. REAL WRITE TEST: step 1 → prepare LOAD +1 (preview) → **ПОДТВЕРДИТЬ ТЕСТОВУЮ ЗАГРУЗКУ +1** → stock read back → prepare UNLOAD −1 → confirm → summary.
6. Afterwards set `KITSHOP_WRITE_ENABLED=false` again until the next phase is approved.

Rehearsal: `node scripts/dev-fake-kitshop.mjs` runs the whole flow against a **local fake** KiT Shop (port 4010) — passed 2026-10-01: CheckAuth PASS, LOAD 7→8, UNLOAD 8→7, UUIDs found in GetFillUps, exactly 2 MakeFillUp calls, ~270 ms per call.
