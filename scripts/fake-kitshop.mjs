// LOCAL FAKE KiT Shop for rehearsing PHASE D end-to-end (never the real api.kitshop.ru).
// Emulates the documented protocol: POST /APIService.svc/{Method}, Auth{CompanyId, RequestId, UserLogin, Sign=MD5(CompanyId+Password+RequestId)},
// strictly increasing RequestId (ResultCode 14), bad Sign (15). Methods: CheckAuth, GetShops, GetProducts, GetShopStocks, MakeFillUp, GetFillUps.
//
// Usage: node scripts/dev-fake-kitshop.mjs   (starts this fake on :4010 and `next dev` on :3100 wired to it)
import http from "node:http";
import { createHash } from "node:crypto";
import path from "node:path";

export const FAKE = { companyId: "999001", login: "fake-api", password: "fake-password", port: 4010 };

const shops = [
  { ShopId: 621583, ShopName: "5 БЦ Сатти 1 этаж", StocksAccounting: true },
  { ShopId: 621826, ShopName: "6 БЦ Сатти А2 этаж", StocksAccounting: true },
];
const products = [
  { ProductId: 810007, ProductName: "Паста с говядиной", Barcode: "4600000000007", VendorCode: "ГР-02" },
  { ProductId: 810010, ProductName: "Цезарь с курицей", Barcode: "4600000000011", VendorCode: "СЛ-01" },
];
const stock = { 621583: { 810007: 7, 810010: 2 }, 621826: { 810007: 3 } };
// one seeded write-off so the "unused dishes" report has something to show
const fillUps = [
  { FillupId: 400, ShopId: 621583, FillupType: 2, FillupSource: 2, FillupDateTime: null, UserName: "seed", Notes: "СПИСАНИЕ: истёк срок", Details: [{ DetailId: 4000, ProductId: 810010, Quantity: -2 }] },
];
let lastRequestId = 0;
let seq = 500;

const p2 = (n) => String(n).padStart(2, "0");
const now = () => {
  const d = new Date(Date.now() + 5 * 3_600_000); // Almaty wall clock
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
};

function handle(method, body) {
  const a = body.Auth ?? {};
  if (String(a.CompanyId) !== FAKE.companyId) return { ResultCode: 9, ErrorMessage: "Компания с таким Id не найдена" };
  if (a.UserLogin !== FAKE.login) return { ResultCode: 11, ErrorMessage: "Пользователь с таким логином не найден" };
  const sign = createHash("md5").update(`${a.CompanyId}${FAKE.password}${a.RequestId}`).digest("hex");
  if (a.Sign !== sign) return { ResultCode: 15, ErrorMessage: "Неверная подпись" };
  if (!(a.RequestId > lastRequestId)) return { ResultCode: 14, ErrorMessage: "Неверный RequestId" };
  lastRequestId = a.RequestId;
  switch (method) {
    case "CheckAuth":
      return { ResultCode: 0, Response: "AuthSucces" };
    case "GetShops":
      return { ResultCode: 0, Shops: shops };
    case "GetProducts":
      return { ResultCode: 0, Products: products };
    case "GetShopStocks": {
      const s = stock[body.Id];
      if (!s) return { ResultCode: 100, Response: "Торговая точка не найдена" };
      return {
        ResultCode: 0,
        Stocks: Object.entries(s).map(([pid, q]) => {
          const p = products.find((x) => x.ProductId === Number(pid));
          return { ProductId: Number(pid), ProductName: p?.ProductName, Barcode: p?.Barcode, Quantity: q };
        }),
      };
    }
    case "MakeFillUp": {
      const s = stock[body.ShopId];
      if (!s) return { ResultCode: 100, Response: "торговая точка не найдена" };
      for (const f of body.FillUps ?? []) s[f.ProductId] = Math.max(0, (s[f.ProductId] ?? 0) + f.Fillup);
      const id = ++seq;
      const sum = (body.FillUps ?? []).reduce((acc, f) => acc + Math.sign(f.Fillup), 0);
      fillUps.push({
        FillupId: id, ShopId: body.ShopId, FillupType: sum > 0 ? 1 : 2, FillupSource: 2, FillupDateTime: now(), UserName: FAKE.login, Notes: body.Notes ?? null,
        Details: (body.FillUps ?? []).map((f, i) => ({ DetailId: id * 10 + i, ProductId: f.ProductId, Quantity: f.Fillup })),
      });
      console.log(`[fake-kitshop] MakeFillUp shop ${body.ShopId}: ${JSON.stringify(body.FillUps)} notes="${body.Notes}"`);
      return { ResultCode: 0, Response: "Успешное загрузка товаров" };
    }
    case "GetSales":
      return { ResultCode: 0, Sales: [{ SaleId: 1, ShopId: 621583, DeviceId: 1, SaleDateTime: now(), Sum: 450 }] };
    case "GetSalesByProducts":
      // pasta sells, caesar does not (for the "unused dishes" report rehearsal)
      return { ResultCode: 0, SalesByProducts: [{ ProductId: 810007, ProductName: "Паста с говядиной", Price: 2500, Quantity: 12, TotalSum: 30000 }] };
    case "GetFillUpById": {
      const f = fillUps.find((x) => x.FillupId === body.Id);
      return f ? { ResultCode: 0, FillUps: [{ ...f, Details: f.Details ?? [] }] } : { ResultCode: 100, Response: "не найдено" };
    }
    case "GetFillUps": {
      const list = fillUps.filter((f) => !body.Filter?.ShopId || f.ShopId === body.Filter.ShopId);
      return list.length ? { ResultCode: 0, FillUps: list } : { ResultCode: 100, Response: "не найдено" };
    }
    default:
      return { ResultCode: 1, ErrorMessage: `fake: method ${method} is not emulated` };
  }
}

export function startFakeKitShop(port = FAKE.port) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const method = (req.url ?? "").split("/").pop();
      let out;
      try {
        out = req.method === "POST" ? handle(method, JSON.parse(raw || "{}")) : { ResultCode: 2, ErrorMessage: "POST only" };
      } catch {
        out = { ResultCode: 2, ErrorMessage: "Некорректный JSON" };
      }
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      }, 250);
    });
  });
  server.listen(port, () => console.log(`[fake-kitshop] listening on http://localhost:${port}/APIService.svc`));
  return server;
}

if (path.basename(process.argv[1] ?? "") === "fake-kitshop.mjs") startFakeKitShop();
