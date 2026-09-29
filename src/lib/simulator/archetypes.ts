import type { CategoryId, LocationType, Weekday } from "../domain/types";

/**
 * Demand archetypes for the 15 simulated fridges.
 * Every fridge deliberately behaves differently so the engine has something to learn.
 * NOTE: the engine never reads these definitions — it only sees generated sales.
 */

export interface Peak {
  /** hour of day (decimal) */
  mu: number;
  sigma: number;
  w: number;
}

export interface Archetype {
  code: string;
  location: string;
  locationType: LocationType;
  workingDays: Weekday[];
  open: number; // minutes
  close: number; // minutes
  baseDaily: number;
  capacity: number;
  /** Multipliers over network category mix. */
  mix: Partial<Record<CategoryId, number>>;
  peaks: Peak[];
  weekday: Partial<Record<Weekday, number>>;
  /** Relative change of the category over the last 180 days (0.5 = +50%). */
  trend: Partial<Record<CategoryId, number>>;
  /** km offsets from the network center */
  pos: [number, number];
  /** proximity zone used for routing ("near" inside a zone) */
  zone: string;
  /** days of history (undefined = full history) — cold start fridge */
  ageDays?: number;
  story: string;
}

const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
const MON_SAT: Weekday[] = [1, 2, 3, 4, 5, 6];
const ALL_DAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const h = (hours: number, minutes = 0) => hours * 60 + minutes;

/** Network-average category mix (shares). */
export const NETWORK_MIX: Record<CategoryId, number> = {
  breakfast: 0.13,
  hot: 0.27,
  salad: 0.16,
  snack: 0.14,
  dessert: 0.12,
  drink: 0.18,
};

export const NETWORK_CENTER = { lat: 55.7512, lng: 37.6184 };

export const ARCHETYPES: Archetype[] = [
  {
    code: "01", zone: "Центр", location: "БЦ Северный · 3 этаж", locationType: "office", workingDays: WEEKDAYS,
    open: h(8), close: h(19), baseDaily: 72, capacity: 110,
    mix: { hot: 1.55, dessert: 0.7 }, peaks: [{ mu: 13, sigma: 1.0, w: 1 }, { mu: 9, sigma: 0.8, w: 0.25 }],
    weekday: { 5: 1.18 }, trend: {}, pos: [0.4, 0.6], story: "любит горячее, пик в обед",
  },
  {
    code: "02", zone: "Центр", location: "Коворкинг Loft", locationType: "coworking", workingDays: ALL_DAYS,
    open: h(9), close: h(21), baseDaily: 58, capacity: 90,
    mix: { dessert: 2.0, salad: 0.7, drink: 1.2 }, peaks: [{ mu: 15.5, sigma: 1.6, w: 1 }, { mu: 12.8, sigma: 1, w: 0.6 }],
    weekday: { 6: 0.7, 7: 0.6 }, trend: {}, pos: [-1.2, 0.3], story: "много десертов, пик после обеда",
  },
  {
    code: "03", zone: "Восток", location: "Технопарк · корпус B", locationType: "office", workingDays: WEEKDAYS,
    open: h(7, 30), close: h(18), baseDaily: 64, capacity: 100,
    mix: { breakfast: 2.1, dessert: 0.8 }, peaks: [{ mu: 8.7, sigma: 0.8, w: 1 }, { mu: 12.5, sigma: 0.9, w: 0.7 }],
    weekday: {}, trend: {}, pos: [2.1, -0.4], story: "пик утром",
  },
  {
    code: "04", zone: "Восток", location: "Фитнес-клуб Pulse", locationType: "gym", workingDays: ALL_DAYS,
    open: h(7), close: h(23), baseDaily: 50, capacity: 80,
    mix: { salad: 1.5, drink: 1.6, dessert: 0.5, hot: 0.7 }, peaks: [{ mu: 19.5, sigma: 1.4, w: 1 }, { mu: 8, sigma: 0.8, w: 0.45 }],
    weekday: { 6: 1.15, 7: 1.1 }, trend: { salad: 0.3 }, pos: [3.8, 2.6], story: "пик вечером, салаты и напитки",
  },
  {
    code: "05", zone: "Центр", location: "БЦ Невский", locationType: "office", workingDays: WEEKDAYS,
    open: h(8), close: h(19), baseDaily: 66, capacity: 100,
    mix: {}, peaks: [{ mu: 12.8, sigma: 1.1, w: 1 }, { mu: 16, sigma: 1, w: 0.3 }],
    weekday: { 1: 0.92 }, trend: {}, pos: [-0.3, -1.1], story: "сбалансированная точка, выходные закрыта",
  },
  {
    code: "06", zone: "Север", location: "Университет · главный корпус", locationType: "university", workingDays: MON_SAT,
    open: h(8), close: h(20), baseDaily: 88, capacity: 130,
    mix: { snack: 1.6, drink: 1.3, hot: 0.85 }, peaks: [{ mu: 11, sigma: 1.0, w: 0.9 }, { mu: 14, sigma: 1.2, w: 1 }],
    weekday: { 6: 0.45 }, trend: { snack: 0.25 }, pos: [1.6, 1.9], story: "перекусы между парами",
  },
  {
    code: "07", zone: "Запад", location: "Клиника «Здоровье»", locationType: "hospital", workingDays: ALL_DAYS,
    open: h(7), close: h(22), baseDaily: 45, capacity: 80,
    mix: { hot: 1.35, dessert: 0.75 }, peaks: [{ mu: 12.5, sigma: 1.2, w: 1 }, { mu: 18, sigma: 1.3, w: 0.6 }],
    weekday: { 6: 0.85, 7: 0.8 }, trend: {}, pos: [-2.4, 1.7], story: "обед и вечерние смены",
  },
  {
    code: "08", zone: "Юг", location: "БЦ Авиатор", locationType: "office", workingDays: WEEKDAYS,
    open: h(8), close: h(19), baseDaily: 78, capacity: 120,
    mix: { hot: 1.35, salad: 1.2, dessert: 0.8 }, peaks: [{ mu: 13.2, sigma: 1.0, w: 1 }],
    weekday: { 5: 1.3 }, trend: { hot: 0.8 }, pos: [0.9, -2.0], story: "горячее растёт, пятница очень сильная",
  },
  {
    code: "09", zone: "Запад", location: "ЖК Парковый · лобби", locationType: "residential", workingDays: ALL_DAYS,
    open: h(7), close: h(23), baseDaily: 40, capacity: 70,
    mix: { breakfast: 1.3, dessert: 1.4, hot: 0.8 }, peaks: [{ mu: 19, sigma: 1.5, w: 1 }, { mu: 8, sigma: 0.9, w: 0.6 }],
    weekday: { 6: 1.25, 7: 1.3 }, trend: {}, pos: [-3.6, -2.8], story: "жилой дом: утро и вечер, выходные сильнее",
  },
  {
    code: "10", zone: "Центр", location: "Коворкинг Hub", locationType: "coworking", workingDays: MON_SAT,
    open: h(9), close: h(20), baseDaily: 52, capacity: 85,
    mix: { salad: 1.6, hot: 0.8 }, peaks: [{ mu: 13.5, sigma: 1.3, w: 1 }],
    weekday: { 6: 0.55 }, trend: {}, pos: [-1.8, -0.9], story: "салаты",
  },
  {
    code: "11", zone: "Север", location: "БЦ Башня · лобби", locationType: "office", workingDays: WEEKDAYS,
    open: h(8), close: h(20), baseDaily: 70, capacity: 105,
    mix: { dessert: 2.1, salad: 0.75 }, peaks: [{ mu: 12.8, sigma: 1.0, w: 0.8 }, { mu: 16, sigma: 1.1, w: 1 }],
    weekday: {}, trend: {}, pos: [0.2, 2.4], story: "десерты во второй половине дня",
  },
  {
    code: "12", zone: "Восток", location: "IT-кампус · блок C", locationType: "office", workingDays: WEEKDAYS,
    open: h(9), close: h(21), baseDaily: 82, capacity: 125,
    mix: { hot: 1.2, drink: 1.1 }, peaks: [{ mu: 14, sigma: 1.1, w: 1 }, { mu: 18.5, sigma: 1.2, w: 0.55 }],
    weekday: { 5: 0.9 }, trend: {}, pos: [2.7, 0.8], story: "поздний обед и вечер",
  },
  {
    code: "13", zone: "Север", location: "Университет · кампус 2", locationType: "university", workingDays: WEEKDAYS,
    open: h(8), close: h(18), baseDaily: 60, capacity: 95,
    mix: { snack: 1.4, breakfast: 1.3, salad: 0.8 }, peaks: [{ mu: 10, sigma: 0.9, w: 0.8 }, { mu: 13, sigma: 1.0, w: 1 }],
    weekday: {}, trend: {}, pos: [1.1, 3.4], story: "утро и обед",
  },
  {
    code: "14", zone: "Юг", location: "Бизнес-центр Порт", locationType: "office", workingDays: MON_SAT,
    open: h(8), close: h(19), baseDaily: 55, capacity: 90,
    mix: {}, peaks: [{ mu: 12.7, sigma: 1.2, w: 1 }],
    weekday: { 6: 0.5 }, trend: { hot: -0.25, salad: -0.2 }, pos: [-0.9, -3.1], story: "спрос постепенно снижается",
  },
  {
    code: "15", zone: "Восток", location: "БЦ Новый Квартал (новая точка)", locationType: "office", workingDays: WEEKDAYS,
    open: h(8), close: h(19), baseDaily: 62, capacity: 100,
    mix: { dessert: 1.3 }, peaks: [{ mu: 13, sigma: 1.1, w: 1 }],
    weekday: {}, trend: {}, pos: [3.1, -1.7], ageDays: 35, story: "новая точка — cold start",
  },
];

export interface ProductDef {
  name: string;
  category: CategoryId;
  price: number;
  popularity: number;
}

export const PRODUCT_DEFS: ProductDef[] = [
  { name: "Сырники со сметаной", category: "breakfast", price: 290, popularity: 1.3 },
  { name: "Омлет с ветчиной", category: "breakfast", price: 270, popularity: 1.0 },
  { name: "Каша овсяная с ягодами", category: "breakfast", price: 210, popularity: 1.1 },
  { name: "Круассан с лососем", category: "breakfast", price: 340, popularity: 0.8 },
  { name: "Блины с творогом", category: "breakfast", price: 250, popularity: 0.7 },

  { name: "Курица терияки с рисом", category: "hot", price: 420, popularity: 1.4 },
  { name: "Паста с говядиной", category: "hot", price: 450, popularity: 1.2 },
  { name: "Плов", category: "hot", price: 390, popularity: 1.0 },
  { name: "Гречка с котлетой", category: "hot", price: 360, popularity: 0.9 },
  { name: "Лазанья", category: "hot", price: 430, popularity: 0.7 },

  { name: "Цезарь с курицей", category: "salad", price: 380, popularity: 1.5 },
  { name: "Греческий салат", category: "salad", price: 320, popularity: 1.0 },
  { name: "Салат с тунцом", category: "salad", price: 390, popularity: 0.5 },
  { name: "Винегрет", category: "salad", price: 220, popularity: 0.7 },
  { name: "Боул с киноа", category: "salad", price: 410, popularity: 0.9 },

  { name: "Сэндвич с индейкой", category: "snack", price: 280, popularity: 1.3 },
  { name: "Ролл с курицей", category: "snack", price: 300, popularity: 1.1 },
  { name: "Сырная тарелка", category: "snack", price: 350, popularity: 0.5 },
  { name: "Хумус с овощами", category: "snack", price: 260, popularity: 0.7 },
  { name: "Пирожок с капустой", category: "snack", price: 120, popularity: 1.0 },

  { name: "Чизкейк", category: "dessert", price: 290, popularity: 1.4 },
  { name: "Тирамису", category: "dessert", price: 310, popularity: 1.1 },
  { name: "Ягодный десерт", category: "dessert", price: 270, popularity: 0.5 },
  { name: "Медовик", category: "dessert", price: 260, popularity: 1.0 },
  { name: "Панна-котта", category: "dessert", price: 240, popularity: 0.7 },

  { name: "Морс клюквенный", category: "drink", price: 150, popularity: 1.1 },
  { name: "Вода 0.5", category: "drink", price: 90, popularity: 1.3 },
  { name: "Смузи манго", category: "drink", price: 260, popularity: 0.8 },
  { name: "Холодный чай", category: "drink", price: 170, popularity: 1.0 },
  { name: "Кефир", category: "drink", price: 120, popularity: 0.6 },
];

/** Russian public holidays (MM-DD). Office-type fridges are closed. */
export const HOLIDAYS_MMDD = [
  "01-01", "01-02", "01-03", "01-04", "01-05", "01-06", "01-07", "01-08",
  "02-23", "03-08", "05-01", "05-09", "06-12", "11-04",
];
