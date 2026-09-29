"use client";

import clsx from "clsx";
import { MobileShell } from "@/components/mobile/MobileShell";
import { SkeletonList } from "@/components/mobile/ui";
import { useMobileRating } from "@/lib/client/mobileApi";
import { fmtClock } from "@/lib/client/format";

export default function MobileRatingPage() {
  const { data } = useMobileRating();
  if (!data) return <MobileShell title="Награды"><SkeletonList /></MobileShell>;
  const p = data.player;
  const next = data.rewards.find((r) => !r.unlocked);

  return (
    <MobileShell title="Награды" now={data.now}>
      <section className="card p-4">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[18px] font-bold">{p.name}</div>
            <div className="text-[14px] text-ink-3">
              Lv {p.level} · {p.title}
            </div>
          </div>
          <div className="num text-right text-[26px] font-bold text-xp">{p.xp} XP</div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-xp" style={{ width: `${Math.round(p.progress * 100)}%` }} />
        </div>
        <div className="mt-1 text-right text-[12px] text-ink-3">до Lv {p.level + 1}: {p.levelTo - p.xp} XP</div>
        {p.streak >= 2 && <div className="mt-2 text-[15px] text-serious">🔥 {p.streak} задач подряд с хорошим результатом</div>}
      </section>

      <section className="card mt-4 p-4">
        <div className="label">OPS POINTS</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Stat value={p.pointsToday} label="сегодня" />
          <Stat value={p.pointsWeek} label="за неделю" />
          <Stat value={p.points} label="всего" />
        </div>
        <p className="mt-3 text-[13px] text-ink-3">Очки начисляются только за подтверждённый результат: блюда продались, полка не опустела, списания не было.</p>
      </section>

      <section className="card mt-4 p-4">
        <div className="label mb-3">Награды</div>
        <div className="space-y-2">
          {data.rewards.map((r) => (
            <div key={r.id} className={clsx("flex items-center gap-3 rounded-xl px-3 py-3", r.unlocked ? "bg-xp/10" : "bg-surface-2")}>
              <span className="text-[22px]">{r.unlocked ? "🎁" : "🔒"}</span>
              <div className="flex-1">
                <div className="text-[15px] font-semibold">{r.points.toLocaleString("ru-RU")} POINTS</div>
                <div className="text-[13px] text-ink-3">
                  {r.title}
                  {r.unlocked ? (r.issued ? " · выдано" : " · разблокировано — обратитесь к администратору") : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
        {next && (
          <>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-xp" style={{ width: `${Math.min(100, Math.round((p.points / next.points) * 100))}%` }} />
            </div>
            <div className="mt-1 text-right text-[12px] text-ink-3">до «{next.title}»: {Math.max(0, next.points - p.points)} points</div>
          </>
        )}
      </section>

      <section className="card mt-4 p-4">
        <div className="label">Команда сегодня</div>
        <div className="num mt-2 text-[34px] font-extrabold">
          {data.team.score}
          <span className="text-[16px] text-ink-3"> / 100</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Stat value={data.team.stockoutsPrevented} label="пустых полок предотвращено" />
          <Stat value={data.team.wastePrevented} label="позиций спасено от списания" />
          <Stat value={data.team.completed} label="задач выполнено" />
        </div>
      </section>

      <section className="card mt-4 p-4">
        <div className="label mb-3">Достижения</div>
        <div className="grid grid-cols-2 gap-2">
          {data.achievements.map((a) => (
            <div key={a.id} className={clsx("rounded-xl p-3", a.unlockedAt ? "bg-surface-2" : "bg-surface-2/50 opacity-70")}>
              <div className="text-[24px]">{a.unlockedAt ? a.emoji : "🔒"}</div>
              <div className="mt-1 text-[14px] font-semibold">{a.title}</div>
              <div className="text-[12px] leading-snug text-ink-3">{a.description}</div>
              {!a.unlockedAt && a.target > 1 && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-ink-2" style={{ width: `${Math.round((a.progress / a.target) * 100)}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {data.recent.length > 0 && (
        <section className="card mt-4 p-4">
          <div className="label mb-2">Последние начисления</div>
          <ul className="space-y-1.5">
            {data.recent.map((e, i) => (
              <li key={i} className="flex items-center gap-3 text-[14px]">
                <span className="num font-mono text-ink-3">{fmtClock(e.at)}</span>
                <span className="flex-1 text-ink-2">{e.reason}</span>
                <span className="num text-xp">+{e.amount}</span>
                {e.points > 0 && <span className="num text-[12px] text-good-ink">+{e.points} pts</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </MobileShell>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="num text-[22px] font-bold">{value.toLocaleString("ru-RU")}</div>
      <div className="text-[12px] leading-tight text-ink-3">{label}</div>
    </div>
  );
}
