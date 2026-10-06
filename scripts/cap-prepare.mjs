// Generates capacitor-www/ (local fallback pages bundled into the APK).
// The Android app normally loads CAP_SERVER_URL; these pages are shown only when the server is unreachable.
// Usage: CAP_SERVER_URL=https://ops.example.kz/m node scripts/cap-prepare.mjs
import fs from "node:fs";
import path from "node:path";

const url = process.env.CAP_SERVER_URL || "https://fridge-ops.onrender.com/m";
if (!/^https?:\/\//.test(url)) throw new Error("CAP_SERVER_URL must start with http:// or https://");
if (/KITSHOP|PASSWORD|SECRET/i.test(url)) throw new Error("CAP_SERVER_URL must be a plain server address");
const out = path.join(process.cwd(), "capacitor-www");
fs.mkdirSync(out, { recursive: true });

const page = (title, body) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0c0e"><title>${title}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0c0e;color:#f2f2f0;font-family:system-ui,-apple-system,Roboto,sans-serif}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;
       padding-top:max(24px,env(safe-area-inset-top));padding-bottom:max(24px,env(safe-area-inset-bottom));text-align:center;box-sizing:border-box}
  .logo{width:64px;height:64px;border-radius:16px;border:2px solid #6ea8ff;display:grid;place-items:center;font-size:28px}
  h1{font-size:22px;margin:0} p{margin:0;color:#b4b5b8;font-size:16px;line-height:1.4;max-width:320px}
  button{margin-top:8px;height:56px;min-width:240px;border:0;border-radius:16px;background:#f2f2f0;color:#0b0c0e;font-size:17px;font-weight:700}
</style></head><body><main>${body}</main></body></html>`;

const target = JSON.stringify(url);

fs.writeFileSync(
  path.join(out, "index.html"),
  page("Apps Холодосов", `<div class="logo">❄</div><h1>Apps Холодосов</h1><p>Открываю…</p>
<script>location.replace(${target});</script>`),
);

fs.writeFileSync(
  path.join(out, "offline.html"),
  page("Нет связи", `<div class="logo">❄</div><h1>Нет связи с сервером</h1>
<p>Проверьте интернет. Отмеченные позиции в начатой задаче сохранены на телефоне и отправятся, когда связь вернётся.</p>
<button onclick="location.replace(${target})">Повторить</button>
<script>window.addEventListener("online",function(){location.replace(${target})});</script>`),
);

console.log(`capacitor-www ready → ${url}`);
