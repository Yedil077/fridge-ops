// Applies Apps Холодосов identity to the Capacitor Android project:
//  • launcher icons (legacy + round + adaptive foreground) for every density
//  • splash screens (portrait/landscape) and Android 12+ SplashScreen theme
//  • dark status/navigation bars matching the web UI
//  • versionName / versionCode from package.json
// Run automatically by `npm run cap:sync`. Safe to run repeatedly.
import fs from "node:fs";
import path from "node:path";
import { iconPng, renderPng } from "./icon-lib.mjs";

const root = process.cwd();
const res = path.join(root, "android", "app", "src", "main", "res");
if (!fs.existsSync(res)) {
  console.log("android/ not found — run `npx cap add android` first");
  process.exit(0);
}
const write = (rel, buf) => {
  const p = path.join(res, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
};

// launcher icons
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(densities)) {
  write(`mipmap-${d}/ic_launcher.png`, iconPng(Math.round(48 * k), 0.1));
  write(`mipmap-${d}/ic_launcher_round.png`, iconPng(Math.round(48 * k), 0.16));
  // adaptive icon foreground: 108dp canvas, glyph inside the 66dp safe zone
  write(`mipmap-${d}/ic_launcher_foreground.png`, iconPng(Math.round(108 * k), 0.26));
}
write(
  "values/ic_launcher_background.xml",
  Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0B0C0E</color>\n</resources>\n`),
);

// splash screens (legacy) — dark background, small centered glyph
const splash = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [d, [w, h]] of Object.entries(splash)) {
  write(`drawable-port-${d}/splash.png`, renderPng(w, h, Math.round(w * 0.32)));
  write(`drawable-land-${d}/splash.png`, renderPng(h, w, Math.round(w * 0.32)));
}
write("drawable/splash.png", renderPng(480, 800, 150));

write(
  "values/colors.xml",
  Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">#0B0C0E</color>
    <color name="colorPrimaryDark">#0B0C0E</color>
    <color name="colorAccent">#6EA8FF</color>
    <color name="fo_background">#0B0C0E</color>
</resources>
`),
);

write(
  "values/styles.xml",
  Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<resources>

    <!-- Base application theme: dark, like the web UI. -->
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.DarkActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>
        <item name="colorAccent">@color/colorAccent</item>
    </style>

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
        <item name="android:statusBarColor">@color/fo_background</item>
        <item name="android:navigationBarColor">@color/fo_background</item>
        <item name="android:windowLightStatusBar">false</item>
    </style>

    <!-- Launch theme (Android 12+ SplashScreen API, legacy splash below 12). -->
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">@color/fo_background</item>
        <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>
</resources>
`),
);

// versioning: versionName = package.json version, versionCode = MAJOR*10000 + MINOR*100 + PATCH
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const [maj, min, pat] = String(pkg.version).split(".").map((x) => parseInt(x, 10) || 0);
const code = maj * 10000 + min * 100 + pat;
const gradle = path.join(root, "android", "app", "build.gradle");
let g = fs.readFileSync(gradle, "utf8");
g = g.replace(/versionCode \d+/, `versionCode ${Math.max(1, code)}`).replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
fs.writeFileSync(gradle, g);

console.log(`android assets ready · version ${pkg.version} (${Math.max(1, code)})`);
