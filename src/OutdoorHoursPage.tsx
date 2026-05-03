/**
 * OutdoorHours — KOUT-7 dashboard.
 *
 * Compares an arbitrary number of counties on "was it comfortable outside?"
 * across four rules (daytime, 45–86°F, UV ≤ 6, ≤1 mm/h rain).
 *
 * Fully static:
 *   /outdoor-hours/{tag}.json         — rollups per time range (1y/5y/10y/30y)
 *   /outdoor-hours/hourly/YYYY-MM.json — hourly drill-in (lazy fetch)
 *
 * Plotly is loaded once via CDN. Region set is data-driven — add a county to
 * the JSON bundle and it appears in the picker.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

declare global { interface Window { Plotly?: any; } }

type Grain = 'yearly' | 'monthly' | 'daily';
type RegionKey = string;

interface MetricMeta { key: string; label: string; unit: string; kind: 'sum' | 'mean' | 'max' | 'pct'; profile_aware?: boolean; }
interface ProfileRule { temp_min_c: number; temp_max_c: number; temp_min_f: number; temp_max_f: number; uv_max: number; rain_max_mm_h: number; cloud_max_pct: number | null; humidity_max_pct: number | null; aqi_max: number | null; }
interface Profile { id: string; name: string; label: string; desc: string; rule: ProfileRule; }
const CUSTOM_PROFILE_ID = 'custom';
// Default custom rule = mid-permissive (matches Goldilocks exactly so first-tweak is intuitive).
const DEFAULT_CUSTOM_RULE: ProfileRule = {
  temp_min_c: 7, temp_max_c: 30, temp_min_f: 45, temp_max_f: 86,
  uv_max: 6, rain_max_mm_h: 1, cloud_max_pct: 85, humidity_max_pct: 80, aqi_max: 100,
};
// CustomResults: per-grain → per-region → bucket-key → good-hour count (and daytime denominator for pct).
type CustomGrainResult = Record<string, Record<string, { stay: number; daytime: number }>>;
type CustomResults = Record<string, CustomGrainResult>;
interface RegionGrainData { label: string; x: (string | number)[]; series: Record<string, (number | null)[]>; }
interface GrainData { tag: string; grain: Grain; x_label: string; regions: Record<RegionKey, RegionGrainData>; }
interface RegionInfo { label: string; short: string; color: string; ink: string; default_on: boolean; }
interface Payload {
  tag: string;
  pubdate?: string;
  metrics: MetricMeta[];
  regions: Record<RegionKey, string>;
  region_registry?: Record<RegionKey, RegionInfo>;
  region_order?: RegionKey[];
  grains: Record<Grain, GrainData>;
  rule: ProfileRule;
  profiles?: Profile[];
  default_profile?: string;
  summaries?: {
    monthly?: Record<string, string>;      // key "YYYY-MM" → one-line narrative
    range_overview?: Record<string, string>; // key = tag → overview sentence
    region_profiles?: Record<string, { best_time: string; strengths: string; watch_out: string }>;
  };
}

interface HourlyRow { ts: string; [region: string]: string | Record<string, number | null>; }
interface HourlyMonth { month: string; rows: HourlyRow[]; }

// Default palette (colorblind-safe, Wong-esque) used as fallback if a region
// key arrives without a registry entry.
const FALLBACK_PALETTE = ['#e45c3a', '#0e8f74', '#8e54c4', '#cc8a1a', '#3b82f6', '#db2777', '#16a34a', '#64748b'];

const RANGE_ORDER: { tag: string; label: string }[] = [
  { tag: 'last30y', label: '30 yrs' },
  { tag: 'last10y', label: '10 yrs' },
  { tag: 'last5y',  label: '5 yrs' },
  { tag: 'last3y',  label: '3 yrs' },
  { tag: 'last1y',  label: '1 yr' },
  { tag: 'last1m',  label: '1 mo' },
];
const DEFAULT_TAG = 'last1m';

const PLOTLY_SRC = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
let plotlyPromise: Promise<void> | null = null;
function loadPlotly(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.Plotly) return Promise.resolve();
  if (plotlyPromise) return plotlyPromise;
  plotlyPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PLOTLY_SRC; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('plotly failed to load'));
    document.head.appendChild(s);
  });
  return plotlyPromise;
}

const HIGHER_BETTER = new Set(['stay_outside_hours', 'pct_daytime_outside', 'sunshine_hours']);
const LOWER_BETTER = new Set(['precipitation_sum', 'cloud_cover_mean', 'wind_gusts_10m_max', 'relative_humidity_2m_mean']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtValue(v: number | null | undefined, unit: string): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`.trim();
}

function summarize(values: (number | null)[], kind: MetricMeta['kind']): number | null {
  const vs = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!vs.length) return null;
  if (kind === 'sum') return vs.reduce((a, b) => a + b, 0);
  if (kind === 'max') return Math.max(...vs);
  return vs.reduce((a, b) => a + b, 0) / vs.length;
}

function findExtremes(xs: (string | number)[], ys: (number | null)[]) {
  let hi = -Infinity, hiI = -1;
  ys.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    if (v > hi) { hi = v; hiI = i; }
  });
  return hiI >= 0 ? { x: xs[hiI], y: hi } : null;
}

// Map a profile-aware metric key onto its per-profile column when the active
// profile differs from default. Returns the original key when the metric is
// not profile-aware or when the goldilocks profile is selected (which is
// also exported under the legacy unsuffixed names).
function effectiveMetricKey(metricKey: string, profileId: string, metrics: MetricMeta[] | undefined): string {
  if (profileId === 'goldilocks') return metricKey;
  const m = metrics?.find(x => x.key === metricKey);
  if (!m?.profile_aware) return metricKey;
  if (metricKey === 'stay_outside_hours') return `stay_outside_${profileId}_hours`;
  if (metricKey === 'pct_daytime_outside') return `pct_daytime_outside_${profileId}`;
  return metricKey;
}

function activeProfile(payload: Payload | null, profileId: string): Profile | null {
  if (!payload?.profiles) return null;
  return payload.profiles.find(p => p.id === profileId) ?? null;
}

// Top-level series read with custom-profile support. Used by the page chart,
// leaderboard, deep-dive panels, and the standalone Leaderboard component.
function readSeries(
  payload: Payload | null,
  region: string,
  metricKey: string,
  profileId: string,
  grain: Grain,
  customResults: CustomResults | null,
): (number | null)[] {
  if (!payload) return [];
  const grainData = payload.grains[grain];
  const regionData = grainData?.regions[region];
  if (!regionData) return [];
  const xs = regionData.x;
  if (profileId === CUSTOM_PROFILE_ID && (metricKey === 'stay_outside_hours' || metricKey === 'pct_daytime_outside')) {
    const bucketResults = customResults?.[grain]?.[region];
    if (!bucketResults) return xs.map(() => null);
    return xs.map((x: any) => {
      const slot = bucketResults[String(x)];
      if (!slot) return null;
      if (metricKey === 'stay_outside_hours') return slot.stay;
      return slot.daytime > 0 ? +(slot.stay / slot.daytime * 100).toFixed(2) : null;
    });
  }
  const eKey = effectiveMetricKey(metricKey, profileId, payload.metrics);
  return regionData.series[eKey] ?? [];
}

// Compact URL encoding for the 7 custom-rule fields. Empty slot = null cap.
// Format: t1,t2,uv,rain,cloud,hum,aqi  e.g. "7,30,6,1,85,80,100" or "7,30,6,1,,,100".
function encodeCustomRuleParam(r: ProfileRule): string {
  const parts = [r.temp_min_c, r.temp_max_c, r.uv_max, r.rain_max_mm_h, r.cloud_max_pct, r.humidity_max_pct, r.aqi_max];
  return parts.map(v => v == null ? '' : String(v)).join(',');
}
function parseCustomRuleParam(raw: string | null): ProfileRule | null {
  if (!raw) return null;
  const p = raw.split(',');
  if (p.length !== 7) return null;
  const num = (s: string) => s === '' ? null : (Number.isFinite(+s) ? +s : NaN);
  const temp_min_c = num(p[0]);
  const temp_max_c = num(p[1]);
  const uv_max = num(p[2]);
  const rain_max_mm_h = num(p[3]);
  if (temp_min_c == null || temp_max_c == null || uv_max == null || rain_max_mm_h == null) return null;
  if ([temp_min_c, temp_max_c, uv_max, rain_max_mm_h].some(v => Number.isNaN(v as number))) return null;
  return {
    temp_min_c: temp_min_c as number,
    temp_max_c: temp_max_c as number,
    temp_min_f: Math.round((temp_min_c as number) * 9 / 5 + 32),
    temp_max_f: Math.round((temp_max_c as number) * 9 / 5 + 32),
    uv_max: uv_max as number,
    rain_max_mm_h: rain_max_mm_h as number,
    cloud_max_pct: num(p[4]),
    humidity_max_pct: num(p[5]),
    aqi_max: num(p[6]),
  };
}

// Bucket key for the active grain (matches what the server-side rollup uses).
// yearly = "YYYY", monthly = "YYYY-MM-01", daily = "YYYY-MM-DD".
function bucketKeyFor(tsLocal: string, grain: Grain): string {
  // tsLocal is an ISO local timestamp string like "2024-03-15T08:00:00-07:00".
  if (grain === 'yearly') return tsLocal.slice(0, 4);
  if (grain === 'monthly') return tsLocal.slice(0, 7) + '-01';
  return tsLocal.slice(0, 10);
}

// Apply a custom rule to one hourly snapshot of regional metrics.
function customRulePass(snap: any, rule: ProfileRule): boolean {
  if (!snap || snap.ok_day !== 1) return false;
  const t = snap.temperature_2m;
  if (t == null || t < rule.temp_min_c || t > rule.temp_max_c) return false;
  const uv = snap.uv_index_est ?? 0;
  if (uv > rule.uv_max) return false;
  const rain = snap.precipitation ?? 0;
  if (rain > rule.rain_max_mm_h) return false;
  if (rule.cloud_max_pct != null && (snap.cloud_cover ?? 0) > rule.cloud_max_pct) return false;
  if (rule.humidity_max_pct != null && (snap.relative_humidity_2m ?? 0) > rule.humidity_max_pct) return false;
  if (rule.aqi_max != null && snap.us_aqi != null && snap.us_aqi > rule.aqi_max) return false;
  return true;
}

// Hourly drill schema embeds these fields per row.region; we read them through `any`
// since the schema isn't strict TS-typed yet.
interface HourSnapshot {
  ok_day: number;
  stay_outside_pts?: number;
  temperature_2m?: number | null;
  uv_index_est?: number | null;
  precipitation?: number | null;
  cloud_cover?: number | null;
  relative_humidity_2m?: number | null;
  us_aqi?: number | null;
}

function prettyBucket(x: string | number, grain: Grain | 'hourly'): string {
  if (grain === 'yearly') return String(x);
  if (grain === 'hourly') {
    const m = String(x).match(/T(\d{2}:\d{2})/);
    return m ? m[1] : String(x);
  }
  const m = String(x).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return String(x);
  const year = +m[1], month = +m[2] - 1, day = m[3] ? +m[3] : null;
  return day ? `${MONTHS[month]} ${day}, ${year}` : `${MONTHS[month]} ${year}`;
}

// ── Detail column schema ──

type ColFmt = 'num0' | 'num1' | 'num2' | 'pts' | 'bool' | 'time';
interface Col { key: string; label: string; fmt?: ColFmt; paired?: boolean; leading?: boolean; }

const DETAIL_COLS: Record<'hourly' | 'daily' | 'monthly', Col[]> = {
  hourly: [
    { key: 'ts',               label: 'Local time',  fmt: 'time', paired: false },
    { key: 'stay_outside_pts', label: 'Stay-out',    fmt: 'pts',  paired: true, leading: true },
    { key: 'ok_day',           label: 'Day?',        fmt: 'bool', paired: true, leading: true },
    { key: 'temperature_2m',   label: 'Temp (°C)',   fmt: 'num1', paired: true },
    { key: 'uv_index_est',     label: 'UV',          fmt: 'num2', paired: true },
    { key: 'precipitation',    label: 'Rain (mm/h)', fmt: 'num2', paired: true },
    { key: 'cloud_cover',      label: 'Cloud (%)',   fmt: 'num0', paired: true },
    { key: 'wind_gusts_10m',   label: 'Gust (m/s)',  fmt: 'num1', paired: true },
  ],
  daily: [
    { key: 'x',                     label: 'Date',               paired: false },
    { key: 'stay_outside_hours',    label: 'Stay-out (h)',       fmt: 'num1', paired: true, leading: true },
    { key: 'pct_daytime_outside',   label: '% daylight usable',  fmt: 'num1', paired: true, leading: true },
    { key: 'temperature_2m_mean',   label: 'Temp avg (°C)',      fmt: 'num1', paired: true },
    { key: 'temperature_2m_max',    label: 'Temp max',           fmt: 'num1', paired: true },
    { key: 'uv_index_est_max',      label: 'UV max',             fmt: 'num2', paired: true },
    { key: 'precipitation_sum',     label: 'Rain (mm)',          fmt: 'num2', paired: true },
    { key: 'cloud_cover_mean',      label: 'Cloud (%)',          fmt: 'num0', paired: true },
    { key: 'wind_gusts_10m_max',    label: 'Peak gust (m/s)',    fmt: 'num1', paired: true },
  ],
  monthly: [
    { key: 'x',                     label: 'Month',              paired: false },
    { key: 'stay_outside_hours',    label: 'Stay-out (h)',       fmt: 'num0', paired: true, leading: true },
    { key: 'pct_daytime_outside',   label: '% daylight usable',  fmt: 'num1', paired: true, leading: true },
    { key: 'temperature_2m_mean',   label: 'Temp avg (°C)',      fmt: 'num1', paired: true },
    { key: 'temperature_2m_max',    label: 'Temp max',           fmt: 'num1', paired: true },
    { key: 'uv_index_est_mean',    label: 'UV avg',              fmt: 'num2', paired: true },
    { key: 'precipitation_sum',     label: 'Rain (mm)',          fmt: 'num1', paired: true },
    { key: 'wind_gusts_10m_max',    label: 'Peak gust (m/s)',    fmt: 'num1', paired: true },
  ],
};

// ── Local drill-down ──

interface DetailRow { _x: string | number; [region: string]: string | number | Record<string, number | null>; }
interface DetailResult { detailGrain: 'hourly' | 'daily' | 'monthly'; rows: DetailRow[]; regions: RegionKey[]; }

function pivotGrain(payload: Payload, fromGrain: Grain, bucket: string | number, regionsOn: Set<string>): DetailResult | null {
  let detailGrain: 'daily' | 'monthly';
  let match: (x: string | number) => boolean;
  if (fromGrain === 'yearly') { detailGrain = 'monthly'; match = x => Number(String(x).slice(0, 4)) === Number(bucket); }
  else if (fromGrain === 'monthly') { detailGrain = 'daily'; match = x => String(x).slice(0, 7) === String(bucket).slice(0, 7); }
  else return null;
  const data = payload.grains[detailGrain];
  const regions = Object.keys(data.regions).filter(r => regionsOn.has(r));
  if (!regions.length) return null;
  const any = data.regions[regions[0]];
  const rows: DetailRow[] = [];
  any.x.forEach((x, i) => {
    if (!match(x)) return;
    const row: DetailRow = { _x: x };
    regions.forEach(r => {
      const rd = data.regions[r];
      if (!rd) return;
      const idx = rd.x.indexOf(x);
      if (idx < 0) return;
      const subset: Record<string, number | null> = {};
      Object.entries(rd.series).forEach(([k, arr]) => { subset[k] = arr[idx]; });
      row[r] = subset;
    });
    rows.push(row);
  });
  return { detailGrain, rows, regions };
}

async function fetchHourlyDay(bucket: string, regionsOn: Set<string>): Promise<DetailResult> {
  const month = bucket.slice(0, 7);
  const r = await fetch(`/outdoor-hours/hourly/${month}.json`);
  if (!r.ok) throw new Error(`hourly fetch failed: ${r.status}`);
  const data: HourlyMonth = await r.json();
  const target = bucket.slice(0, 10);
  const rows = data.rows
    .filter(row => String(row.ts).slice(0, 10) === target)
    .map(row => {
      const out: DetailRow = { _x: row.ts };
      Object.keys(row).forEach(k => {
        if (k === 'ts') return;
        if (regionsOn.has(k)) out[k] = row[k] as Record<string, number | null>;
      });
      return out;
    });
  return { detailGrain: 'hourly', rows, regions: Array.from(regionsOn) };
}

function fmtCell(v: number | string | null | undefined, fmt?: ColFmt): string | JSX.Element {
  if (v == null || v === '') return '';
  if (fmt === 'time') {
    const m = String(v).match(/T(\d{2}:\d{2})/);
    return m ? m[1] : String(v);
  }
  if (fmt === 'bool') {
    const n = Number(v);
    return <span className={n ? 'text-[#0e8f74] font-bold' : 'text-[#c44] font-bold'}>{n ? '✓' : '✗'}</span>;
  }
  if (fmt === 'pts') {
    const n = Number(v);
    const cls = n === 0 ? 'text-[#c44]' : n === 3 ? 'text-[#0e8f74]' : 'text-[#d4831b]';
    return <span className={`${cls} font-bold`}>{n}/3</span>;
  }
  const num = Number(v);
  if (!Number.isFinite(num)) return '';
  const d = fmt === 'num0' ? 0 : fmt === 'num2' ? 2 : 1;
  return num.toFixed(d);
}

function leadingWinner(row: DetailRow, key: string, regions: RegionKey[]): RegionKey | null {
  const vals = regions
    .map(r => ({ r, v: (row[r] as Record<string, number | null> | undefined)?.[key] }))
    .filter(e => e.v != null && Number.isFinite(Number(e.v)));
  if (vals.length < 2) return null;
  return vals.reduce((a, b) => (Number(b.v) > Number(a.v) ? b : a)).r;
}

// ── Helpers keyed by region registry ──

function registryColor(payload: Payload, region: RegionKey, idx: number): string {
  return payload.region_registry?.[region]?.color || FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length];
}
function registryInk(payload: Payload, region: RegionKey): string {
  return payload.region_registry?.[region]?.ink || '#333';
}
function registryShort(payload: Payload, region: RegionKey): string {
  return payload.region_registry?.[region]?.short || region.slice(0, 3).toUpperCase();
}
function registryLabel(payload: Payload, region: RegionKey): string {
  return payload.region_registry?.[region]?.label || payload.regions[region] || region;
}
function registryOrder(payload: Payload): RegionKey[] {
  return payload.region_order || Object.keys(payload.regions);
}

// ── Page component ──

interface Crumb { grain: Grain | 'hourly-drill'; bucket: string | number; xLabel: string; }

export function OutdoorHoursPage() {
  // URL ↔ state sync. Sharable views: ?tag=last5y&metric=us_aqi_mean&profile=sun_seeker
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = {
    tag: searchParams.get('tag') || DEFAULT_TAG,
    grain: (searchParams.get('grain') as Grain) || 'daily',
    metric: searchParams.get('metric') || 'stay_outside_hours',
    profile: searchParams.get('profile') || 'goldilocks',
    regions: searchParams.get('regions')?.split(',').filter(Boolean) ?? null,
    yoy: searchParams.get('yoy') === '1',
    customRule: parseCustomRuleParam(searchParams.get('cr')),
  };

  // Cache of fetched payloads per tag
  const payloadCache = useRef<Record<string, Payload>>({});
  const [tag, setTag] = useState<string>(initial.tag);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<Set<string>>(new Set([initial.tag]));
  const [grain, setGrain] = useState<Grain>(initial.grain);
  const [metricKey, setMetricKey] = useState<string>(initial.metric);
  const [profileId, setProfileId] = useState<string>(initial.profile);
  const [regionsOn, setRegionsOn] = useState<Set<RegionKey>>(new Set(initial.regions ?? []));
  const [yoy, setYoy] = useState<boolean>(initial.yoy);
  const [customRule, setCustomRule] = useState<ProfileRule>(initial.customRule ?? DEFAULT_CUSTOM_RULE);
  const [customResults, setCustomResults] = useState<CustomResults | null>(null);
  const [customComputing, setCustomComputing] = useState(false);
  const [customComputedFor, setCustomComputedFor] = useState<string | null>(null);  // "tag|ruleHash"
  const [drillStack, setDrillStack] = useState<Crumb[]>([]);
  const [detailResult, setDetailResult] = useState<DetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [plotlyReady, setPlotlyReady] = useState<boolean>(typeof window !== 'undefined' && !!window.Plotly);
  const [tutorialOpen, setTutorialOpen] = useState<boolean>(false);
  const chartRef = useRef<HTMLDivElement>(null);

  // First-visit auto-open the tour. Once dismissed, set localStorage flag so it stops.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (!window.localStorage.getItem('outdoor_hours_seen_tour_v1')) setTutorialOpen(true);
    } catch { /* private mode etc — silently skip */ }
  }, []);
  const closeTutorial = useCallback(() => {
    setTutorialOpen(false);
    try { window.localStorage.setItem('outdoor_hours_seen_tour_v1', '1'); } catch { /* noop */ }
  }, []);
  // True until regionsOn has been seeded from URL or default_on registry — prevents
  // the initial empty Set from being written back to the URL as `regions=`.
  const regionsSeeded = useRef<boolean>(initial.regions !== null);

  // Push state → URL whenever any sharable state changes.
  useEffect(() => {
    const next = new URLSearchParams();
    if (tag !== DEFAULT_TAG) next.set('tag', tag);
    if (grain !== 'daily') next.set('grain', grain);
    if (metricKey !== 'stay_outside_hours') next.set('metric', metricKey);
    if (profileId !== 'goldilocks') next.set('profile', profileId);
    if (yoy) next.set('yoy', '1');
    if (profileId === CUSTOM_PROFILE_ID) {
      const cr = encodeCustomRuleParam(customRule);
      if (cr !== encodeCustomRuleParam(DEFAULT_CUSTOM_RULE)) next.set('cr', cr);
    }
    if (regionsSeeded.current) {
      const defaults = payload ? new Set(registryOrder(payload).filter(r => payload.region_registry?.[r]?.default_on)) : new Set();
      const sortedOn = Array.from(regionsOn).sort();
      const sortedDefault = Array.from(defaults).sort();
      if (sortedOn.join(',') !== sortedDefault.join(',')) next.set('regions', sortedOn.join(','));
    }
    setSearchParams(next, { replace: true });
  }, [tag, grain, metricKey, profileId, yoy, regionsOn, customRule, payload, setSearchParams]);

  // Load Plotly once. Track readiness in state so the chart effect re-runs
  // after the CDN script lands (necessary when payload loads first).
  useEffect(() => {
    loadPlotly().then(() => setPlotlyReady(true)).catch(e => setError(String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true); setError(null);
      if (payloadCache.current[tag]) {
        if (!cancelled) { setPayload(payloadCache.current[tag]); setLoading(false); }
        return;
      }
      try {
        const r = await fetch(`/outdoor-hours/${tag}.json`);
        if (!r.ok) throw new Error(`${tag}: ${r.status}`);
        const p: Payload = await r.json();
        payloadCache.current[tag] = p;
        if (cancelled) return;
        setPayload(p);
        // First time: seed regionsOn from registry default_on (unless URL pre-seeded).
        if (!regionsSeeded.current && !regionsOn.size) {
          const on = new Set<string>(
            (p.region_order || Object.keys(p.regions)).filter(r => p.region_registry?.[r]?.default_on)
          );
          if (on.size < 2) { Object.keys(p.regions).slice(0, 2).forEach(r => on.add(r)); }
          setRegionsOn(on);
          regionsSeeded.current = true;
        } else if (!regionsSeeded.current) {
          // URL provided regions but state was empty (race) — mark seeded.
          regionsSeeded.current = true;
        }
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);

  // Probe which tags are available on disk so we can dim unavailable ones.
  useEffect(() => {
    const run = async () => {
      const tags = RANGE_ORDER.map(r => r.tag);
      const checks = await Promise.all(tags.map(async t => {
        try { const r = await fetch(`/outdoor-hours/${t}.json`, { method: 'HEAD' }); return r.ok ? t : null; }
        catch { return null; }
      }));
      setAvailableTags(new Set(checks.filter((x): x is string => !!x)));
    };
    run();
  }, []);

  const meta = payload?.metrics.find(m => m.key === metricKey);
  const visibleRegions = useMemo(() => (payload ? registryOrder(payload).filter(r => regionsOn.has(r)) : []), [payload, regionsOn]);

  // ── Custom-profile compute: re-aggregate hourly drill JSONs against the custom rule. ──
  const customRuleHash = useMemo(() => JSON.stringify(customRule), [customRule]);
  const customExpectedKey = `${tag}|${customRuleHash}`;
  const customStale = customComputedFor !== customExpectedKey;

  const recomputeCustom = useCallback(async () => {
    if (!payload) return;
    setCustomComputing(true);
    try {
      // Discover the months we need from the payload's daily x array (any region works).
      const dailyData = payload.grains.daily;
      const firstRegion = Object.keys(dailyData.regions)[0];
      const dailyXs: string[] = (dailyData.regions[firstRegion]?.x ?? []).map((x: any) => String(x));
      const months = Array.from(new Set(dailyXs.map(d => d.slice(0, 7)))).sort();
      // Fetch all monthly hourly bundles in parallel (browser caches dedupe).
      const fetched = await Promise.all(months.map(async m => {
        try {
          const r = await fetch(`/outdoor-hours/hourly/${m}.json`);
          if (!r.ok) return null;
          return await r.json();
        } catch { return null; }
      }));

      // Aggregate per (grain × region × bucket).
      const accum: CustomResults = { yearly: {}, monthly: {}, daily: {} };
      for (const m of fetched) {
        if (!m?.rows) continue;
        for (const row of m.rows) {
          const ts: string = row.ts;
          for (const region of Object.keys(row)) {
            if (region === 'ts') continue;
            const snap = row[region] as HourSnapshot;
            const pass = customRulePass(snap, customRule);
            const isDay = snap?.ok_day === 1;
            for (const g of (['yearly', 'monthly', 'daily'] as Grain[])) {
              const key = bucketKeyFor(ts, g);
              if (!accum[g][region]) accum[g][region] = {};
              const slot = accum[g][region][key] ?? (accum[g][region][key] = { stay: 0, daytime: 0 });
              if (isDay) slot.daytime += 1;
              if (pass) slot.stay += 1;
            }
          }
        }
      }
      setCustomResults(accum);
      setCustomComputedFor(`${tag}|${customRuleHash}`);
    } finally {
      setCustomComputing(false);
    }
  }, [payload, tag, customRule, customRuleHash]);

  // Auto-recompute when entering Custom mode for the first time on a tag, or when tag changes.
  useEffect(() => {
    if (profileId !== CUSTOM_PROFILE_ID) return;
    if (customStale && !customComputing) recomputeCustom();
  }, [profileId, customStale, customComputing, recomputeCustom]);

  // Read helper alias bound to current closure (delegates to the top-level pure fn).
  const seriesFor = useCallback((region: string, mKey: string, g: Grain): (number | null)[] => {
    return readSeries(payload, region, mKey, profileId, g, customResults);
  }, [payload, profileId, customResults]);

  // ── Plotly ──
  // YoY only meaningful for monthly/daily grains (not yearly).
  const yoyActive = yoy && grain !== 'yearly' && visibleRegions.length > 0;
  useEffect(() => {
    if (!plotlyReady || !payload || !chartRef.current || !window.Plotly || !meta) return;
    const grainData = payload.grains[grain];
    const eKey = effectiveMetricKey(metricKey, profileId, payload.metrics);

    let traces: any[];
    let xaxisCfg: any;

    if (yoyActive) {
      // Year-over-year: focus on the first visible region; one trace per year,
      // x-axis collapsed to "month" (1-12) for monthly grain or "day-of-year"
      // for daily grain. Color by year along a viridis-ish gradient.
      const focusRegion = visibleRegions[0];
      const s = grainData.regions[focusRegion];
      const xs = s.x;
      const ys = seriesFor(focusRegion, metricKey, grain);
      const byYear = new Map<number, { x: number[]; y: (number | null)[] }>();
      for (let i = 0; i < xs.length; i++) {
        const isoStr = String(xs[i]);
        const m = isoStr.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
        if (!m) continue;
        const yr = +m[1];
        const xVal = grain === 'monthly' ? +m[2] : (() => {
          const d = new Date(isoStr);
          const start = Date.UTC(yr, 0, 1);
          return Math.floor((d.getTime() - start) / 86400000) + 1;
        })();
        if (!byYear.has(yr)) byYear.set(yr, { x: [], y: [] });
        const bucket = byYear.get(yr)!;
        bucket.x.push(xVal);
        bucket.y.push(ys[i] as number | null);
      }
      const years = Array.from(byYear.keys()).sort();
      const yMin = years[0], yMax = years[years.length - 1];
      const palette = (yr: number) => {
        // viridis-ish: deep blue → teal → green → yellow
        const t = years.length > 1 ? (yr - yMin) / (yMax - yMin) : 0.5;
        const stops = [[68, 1, 84], [49, 104, 142], [33, 144, 141], [94, 201, 98], [253, 231, 37]];
        const seg = t * (stops.length - 1);
        const i = Math.min(Math.floor(seg), stops.length - 2);
        const f = seg - i;
        const a = stops[i], b = stops[i + 1];
        const r = Math.round(a[0] + (b[0] - a[0]) * f);
        const g = Math.round(a[1] + (b[1] - a[1]) * f);
        const bl = Math.round(a[2] + (b[2] - a[2]) * f);
        return `rgb(${r},${g},${bl})`;
      };
      traces = years.map(yr => ({
        x: byYear.get(yr)!.x,
        y: byYear.get(yr)!.y,
        name: String(yr),
        type: 'scatter', mode: grain === 'monthly' ? 'lines+markers' : 'lines',
        line: { width: yr === yMax ? 3.2 : 1.6, color: palette(yr) },
        marker: { size: grain === 'monthly' ? 7 : 4, color: palette(yr) },
        opacity: yr === yMax ? 1 : 0.85,
        hovertemplate: `<b>${yr}</b><br>${grain === 'monthly' ? 'Month %{x}' : 'Day %{x}'}<br>${meta.label}: %{y:.2f} ${meta.unit}<extra></extra>`,
      }));
      xaxisCfg = grain === 'monthly'
        ? { title: { text: 'Month', font: { size: 15, color: '#6b7388' } }, tickmode: 'array', tickvals: [1,2,3,4,5,6,7,8,9,10,11,12], ticktext: MONTHS, showgrid: true, gridcolor: '#eef0f5', linecolor: '#c9cedb', tickcolor: '#c9cedb', tickfont: { size: 14 } }
        : { title: { text: 'Day of year', font: { size: 15, color: '#6b7388' } }, showgrid: true, gridcolor: '#eef0f5', linecolor: '#c9cedb', tickcolor: '#c9cedb', tickfont: { size: 14 } };
    } else {
      traces = visibleRegions
        .filter(r => grainData.regions[r])
        .map((r, idx) => {
          const s = grainData.regions[r];
          const color = registryColor(payload, r, idx);
          return {
            x: s.x, y: seriesFor(r, metricKey, grain), name: s.label, type: 'scatter', mode: 'lines+markers',
            marker: { size: grain === 'yearly' ? 11 : 7, color, line: { width: 1, color: 'white' } },
            line: { width: 3, color },
            meta: r,
            hovertemplate: `<b>${s.label}</b><br>%{x}<br>${meta.label}: %{y:.2f} ${meta.unit}<br><i>(click to drill in)</i><extra></extra>`,
          };
        });
      xaxisCfg = { title: { text: grainData.x_label, font: { size: 15, color: '#6b7388' } }, type: grain === 'yearly' ? 'linear' : 'date', showgrid: true, gridcolor: '#eef0f5', linecolor: '#c9cedb', tickcolor: '#c9cedb', tickfont: { size: 14 } };
    }

    const inter = 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    const display = "'Instrument Serif', Georgia, serif";
    const mono = "'JetBrains Mono', ui-monospace, monospace";
    const ink = '#f7f4eb';        // matches --ink (cream)
    const inkDim = '#cdc7b6';     // matches --ink-dim
    const inkFaint = '#9c977d';   // matches --ink-faint
    const lineSoft = 'rgba(255,255,255,0.08)';
    const grainWord = { yearly: 'year', monthly: 'month', daily: 'day' }[grain];
    const titleText = yoyActive
      ? `${meta.label}  <span style="color:${inkFaint};font-weight:400">year-over-year · ${registryLabel(payload, visibleRegions[0])}</span>`
      : `${meta.label}  <span style="color:${inkFaint};font-weight:400">per ${grainWord}</span>`;
    const layout = {
      title: { text: titleText, font: { family: display, size: 30, color: ink }, x: 0.02, xanchor: 'left', y: 0.96 },
      font: { family: inter, color: inkDim, size: 13 },
      xaxis: { ...xaxisCfg, tickfont: { ...(xaxisCfg.tickfont || {}), family: mono, size: 11, color: inkFaint }, title: xaxisCfg.title ? { ...xaxisCfg.title, font: { ...(xaxisCfg.title?.font || {}), family: mono, size: 11, color: inkFaint } } : undefined, gridcolor: lineSoft, linecolor: lineSoft, tickcolor: lineSoft },
      yaxis: { title: { text: `${meta.label} (${meta.unit})`, font: { family: mono, size: 11, color: inkFaint } }, showgrid: true, gridcolor: lineSoft, zerolinecolor: lineSoft, linecolor: lineSoft, tickcolor: lineSoft, tickfont: { family: mono, size: 11, color: inkFaint }, rangemode: meta.key === 'stay_outside_hours' ? 'tozero' : undefined },
      hovermode: yoyActive ? 'closest' : 'x unified',
      hoverlabel: { bgcolor: 'rgba(20,26,46,0.95)', bordercolor: 'rgba(255,255,255,0.15)', font: { color: ink, family: inter, size: 13 } },
      legend: { orientation: 'h', y: -0.18, font: { family: mono, size: 11, color: inkDim }, bgcolor: 'rgba(0,0,0,0)' },
      margin: { l: 80, r: 32, t: 80, b: 80 },
      plot_bgcolor: 'rgba(0,0,0,0)', paper_bgcolor: 'rgba(0,0,0,0)',
    };
    window.Plotly.newPlot(chartRef.current, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] });

    const node: any = chartRef.current;
    const onClick = (ev: any) => {
      if (!ev.points?.length || yoyActive) return;
      const p = ev.points[0];
      const rawX = p.data.x[p.pointIndex];
      if (grain !== 'daily') openDrill(grain, rawX);
    };
    node.on?.('plotly_click', onClick);
    return () => { node.removeAllListeners?.('plotly_click'); };
  }, [plotlyReady, payload, grain, metricKey, profileId, yoyActive, meta, visibleRegions, seriesFor, customResults]);

  const openDrill = useCallback((g: Grain, bucket: string | number) => {
    if (g === 'daily') return;
    setDrillStack([{ grain: g, bucket, xLabel: prettyBucket(bucket, g) }]);
  }, []);

  useEffect(() => {
    if (!payload || !drillStack.length) { setDetailResult(null); return; }
    const current = drillStack[drillStack.length - 1];
    setDetailLoading(true);
    const run = async () => {
      try {
        if (current.grain === 'hourly-drill') {
          const result = await fetchHourlyDay(String(current.bucket), regionsOn);
          setDetailResult(result);
        } else {
          const result = pivotGrain(payload, current.grain as Grain, current.bucket, regionsOn);
          setDetailResult(result);
        }
      } catch (e) {
        setDetailResult(null); setError(String(e));
      } finally {
        setDetailLoading(false);
      }
    };
    run();
  }, [drillStack, payload, regionsOn]);

  const drillFurther = useCallback((newGrain: Grain | 'hourly-drill', newBucket: string | number, newLabel: string) => {
    setDrillStack(prev => [...prev, { grain: newGrain, bucket: newBucket, xLabel: newLabel }]);
  }, []);
  const drillTo = useCallback((index: number) => { setDrillStack(prev => prev.slice(0, index + 1)); }, []);
  const closeDetail = useCallback(() => { setDrillStack([]); setFullscreen(false); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drillStack.length) closeDetail(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drillStack, closeDetail]);

  const toggleRegion = useCallback((r: RegionKey) => {
    setRegionsOn(prev => {
      const next = new Set(prev);
      if (next.has(r)) {
        if (next.size <= 1) return prev;
        next.delete(r);
      } else {
        next.add(r);
      }
      return next;
    });
  }, []);

  // ── Ranked leaderboard ──
  const leaderboard = useMemo(() => {
    if (!payload || !meta) return [];
    const g = payload.grains[grain];
    const kind = meta.kind;
    return visibleRegions
      .filter(r => g.regions[r])
      .map((r, idx) => {
        const s = g.regions[r];
        const ys = seriesFor(r, metricKey, grain);
        return {
          region: r,
          label: registryLabel(payload, r),
          short: registryShort(payload, r),
          color: registryColor(payload, r, idx),
          ink: registryInk(payload, r),
          value: summarize(ys, kind),
          peak: findExtremes(s.x, ys),
        };
      })
      .filter(r => r.value != null && Number.isFinite(r.value))
      .sort((a, b) => {
        const hl = HIGHER_BETTER.has(metricKey);
        const ll = LOWER_BETTER.has(metricKey);
        return ll ? (a.value! - b.value!) : hl ? (b.value! - a.value!) : 0;
      });
  }, [payload, grain, metricKey, profileId, meta, visibleRegions, seriesFor]);

  const hasDirection = HIGHER_BETTER.has(metricKey) || LOWER_BETTER.has(metricKey);

  // ── Quick Take ──
  const takeawayHtml = useMemo(() => {
    if (!payload || !meta || leaderboard.length < 2) {
      return `<em>${meta?.label ?? 'Measurement'}</em> shown for ${leaderboard.length ? leaderboard[0].label : 'no counties'}. Toggle another county below to compare.`;
    }
    const leader = leaderboard[0];
    const trailer = leaderboard[leaderboard.length - 1];
    const spread = Math.abs(leader.value! - trailer.value!);
    const pct = spread / Math.max(Math.abs(leader.value!), Math.abs(trailer.value!)) * 100;
    const verb = LOWER_BETTER.has(metricKey) ? 'the least' : HIGHER_BETTER.has(metricKey) ? 'the most' : null;
    if (verb) {
      let out = `<span style="color:${leader.color}"><strong>${leader.label.replace(/,.*$/, '')}</strong></span> has ${verb} <em>${meta.label.toLowerCase()}</em> — <span class="font-bold tabular-nums">${fmtValue(leader.value!, meta.unit)}</span>`;
      if (leaderboard.length > 2) out += ` (best of ${leaderboard.length} counties)`;
      out += `. <span style="color:${trailer.color}"><strong>${trailer.label.replace(/,.*$/, '')}</strong></span> comes last at <span class="font-bold tabular-nums">${fmtValue(trailer.value!, meta.unit)}</span> — a <span class="font-bold tabular-nums">${pct.toFixed(0)}%</span> gap.`;
      return out;
    }
    return `<em>${meta.label}</em> across ${leaderboard.length} counties: ` + leaderboard.map(r => `<span style="color:${r.color}"><strong>${r.short}</strong> <span class="font-bold tabular-nums">${fmtValue(r.value!, meta.unit)}</span></span>`).join(', ') + '.';
  }, [leaderboard, meta, payload, metricKey]);

  const auxHtml = useMemo(() => {
    if (!meta || !leaderboard.length) return '';
    const bits: string[] = [];
    if (leaderboard.every(r => r.peak)) {
      bits.push('Peaks: ' + leaderboard.slice(0, 4).map(r =>
        `<span style="color:${r.color}">${r.short} hit <span class="font-bold tabular-nums">${fmtValue(r.peak!.y, meta.unit)}</span> in ${prettyBucket(r.peak!.x, grain)}</span>`
      ).join(' · ') + '.');
    }
    if (metricKey === 'stay_outside_hours' && leaderboard.length >= 2) {
      const gap = Math.abs(leaderboard[0].value! - leaderboard[leaderboard.length - 1].value!);
      const days = gap / 8;
      if (days >= 1) bits.push(`Gap leader→last: roughly <span class="font-bold tabular-nums">${days.toFixed(0)}</span> extra outdoor-friendly days.`);
    }
    return bits.join(' ');
  }, [leaderboard, meta, metricKey, grain]);

  // ── Render ──

  if (error) return <div className="p-8 text-red-600">Failed to load: {error}</div>;
  if (loading || !payload || !meta) return <div className="p-8 text-slate-500">Loading the weather data…</div>;

  const rangeBadge = RANGE_ORDER.find(r => r.tag === tag)?.label ?? tag;

  const nextStepFor = (detailGrain: 'hourly' | 'daily' | 'monthly', rawX: string | number): { grain: Grain | 'hourly-drill'; bucket: string | number; label: string } | null => {
    if (detailGrain === 'daily') {
      const day = String(rawX).slice(0, 10);
      return { grain: 'hourly-drill', bucket: day, label: prettyBucket(day, 'daily') };
    }
    if (detailGrain === 'monthly') {
      const month = String(rawX).slice(0, 7);
      return { grain: 'monthly', bucket: `${month}-01`, label: prettyBucket(`${month}-01`, 'monthly') };
    }
    return null;
  };

  return (
    <div className="outdoor-atlas min-h-screen">
      <style>{`
        /* ───── Outdoor Atlas — editorial-meteorology theme ───── */
        .outdoor-atlas {
          --ink: oklch(0.97 0.015 85);
          --ink-dim: oklch(0.78 0.02 85);
          --ink-faint: oklch(0.55 0.02 85);
          --bg: oklch(0.16 0.035 255);
          --bg-2: oklch(0.20 0.045 255);
          --bg-3: oklch(0.24 0.05 255);
          --line: oklch(0.32 0.04 255);
          --line-soft: oklch(0.28 0.035 255);
          --accent: oklch(0.88 0.18 85);
          background: var(--bg);
          color: var(--ink);
          position: relative;
          overflow-x: hidden;
        }
        .outdoor-atlas .display { font-family: 'Instrument Serif', serif; font-weight: 400; letter-spacing: -0.01em; }
        .outdoor-atlas .mono    { font-family: 'JetBrains Mono', monospace; }

        /* ── Font roles (per design handoff) ───────────────────────────
           Display = Instrument Serif (hero, h2/h3, big stat numbers, county names)
           Mono    = JetBrains Mono   (eyebrows, units, axis ticks, badges)
           UI/body = Inter            (default — already loaded site-wide) */

        /* Editorial display: section headings + the big numerals in stat cards. */
        .outdoor-atlas h1,
        .outdoor-atlas h2,
        .outdoor-atlas h3 {
          font-family: 'Instrument Serif', Georgia, serif !important;
          font-weight: 400 !important;
          letter-spacing: -0.02em;
        }
        .outdoor-atlas h1 em,
        .outdoor-atlas h2 em,
        .outdoor-atlas h3 em,
        .outdoor-atlas .display em { font-style: italic; color: var(--accent); }

        /* Big stat numerals — Time-range badge, leader stat values, etc. */
        .outdoor-atlas .text-3xl.tabular-nums,
        .outdoor-atlas .text-2xl.tabular-nums,
        .outdoor-atlas .text-\\[28px\\].tabular-nums,
        .outdoor-atlas .text-\\[22px\\].font-extrabold,
        .outdoor-atlas .text-\\[19px\\].font-extrabold {
          font-family: 'Instrument Serif', Georgia, serif !important;
          font-weight: 400 !important;
          letter-spacing: -0.015em;
        }

        /* JetBrains Mono: eyebrows, badges, tags, tracked uppercase labels. */
        .outdoor-atlas .uppercase.tracking-wider,
        .outdoor-atlas .uppercase.tracking-widest,
        .outdoor-atlas [class*="tracking-\\[0\\.1"],
        .outdoor-atlas [class*="tracking-\\[0\\.14"],
        .outdoor-atlas .font-mono,
        .outdoor-atlas code, .outdoor-atlas kbd {
          font-family: 'JetBrains Mono', ui-monospace, monospace !important;
          letter-spacing: 0.06em;
        }

        /* ── Kill light gradient overlays — they paint white-to-pastel
           ON TOP of bg-white (which is now dark glass), making text
           invisible. Drop the gradient image; the dark base shows through. */
        .outdoor-atlas [class*="from-white"],
        .outdoor-atlas [class*="from-[#fff"],
        .outdoor-atlas [class*="from-[#fa"],
        .outdoor-atlas [class*="from-[#f7"],
        .outdoor-atlas [class*="from-[#ee"],
        .outdoor-atlas [class*="from-[#df"] {
          background-image: none !important;
        }
        /* Leader stat card (white-to-soft-yellow): warm tinted bg so the
           leader still pops. Targeted via the most distinctive class combo. */
        .outdoor-atlas [class*="from-white"][class*="to-[#fff8d8]"] {
          background-image: linear-gradient(180deg, oklch(0.26 0.10 80 / 0.55), oklch(0.18 0.05 255 / 0.6)) !important;
          box-shadow: 0 0 28px oklch(0.88 0.18 85 / 0.22), inset 0 1px 0 oklch(1 0 0 / 0.05) !important;
        }
        /* Quick Take card (white→fafbff): soft indigo tint */
        .outdoor-atlas [class*="from-white"][class*="to-[#fafbff]"] {
          background-image: linear-gradient(135deg, oklch(0.22 0.06 270 / 0.5), oklch(0.17 0.04 255 / 0.55)) !important;
        }
        /* KOUT writer card (warm yellow tint) */
        .outdoor-atlas [class*="from-[#fffbea]"][class*="to-[#fff4d0]"] {
          background-image: linear-gradient(135deg, oklch(0.24 0.10 80 / 0.45), oklch(0.18 0.06 80 / 0.4)) !important;
        }

        /* Catch any other lingering pastel surfaces. */
        .outdoor-atlas [class*="bg-[#dfe9ff]"],
        .outdoor-atlas [class*="bg-[#eef5ff]"] { background-color: oklch(0.22 0.05 255 / 0.45) !important; }
        /* Inline-styled pale icon backgrounds in rule cards: keep visible
           but lift a touch so dark icon glyphs read clearly. */
        .outdoor-atlas .text-\\[28px\\].leading-none { filter: drop-shadow(0 0 4px oklch(0 0 0 / 0.4)); }

        /* Atmospheric backdrop */
        .outdoor-atlas .atmos { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
        .outdoor-atlas .atmos::before {
          content:''; position:absolute; inset:-10%;
          background:
            radial-gradient(900px 500px at 18% 12%, oklch(0.32 0.10 260 / 0.55), transparent 60%),
            radial-gradient(800px 600px at 85% 8%, oklch(0.30 0.10 200 / 0.45), transparent 60%),
            radial-gradient(1100px 700px at 60% 90%, oklch(0.26 0.08 280 / 0.55), transparent 60%);
          filter: blur(8px);
        }
        .outdoor-atlas .atmos::after {
          content:''; position:absolute; inset:0;
          background-image: radial-gradient(circle at 50% 50%, oklch(1 0 0 / 0.04) 0.5px, transparent 1px);
          background-size: 3px 3px; opacity:.35; mix-blend-mode: screen;
        }
        .outdoor-atlas .grid-overlay {
          position: fixed; inset:0; z-index:0; pointer-events:none;
          background-image: linear-gradient(to right, oklch(1 0 0 / 0.025) 1px, transparent 1px);
          background-size: 80px 80px;
          mask-image: linear-gradient(to bottom, black, black 60%, transparent);
        }

        /* Live weather */
        .outdoor-atlas .live-weather { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
        .outdoor-atlas .lw-sun {
          position: absolute; right: 8%; top: 60px; width: 220px; height: 220px; border-radius: 50%;
          background: radial-gradient(circle, oklch(0.92 0.16 80 / 0.55) 0%, oklch(0.85 0.18 70 / 0.18) 40%, transparent 70%);
          filter: blur(8px); animation: lw-sun-pulse 7s ease-in-out infinite;
        }
        @keyframes lw-sun-pulse { 0%,100% { transform: scale(1); opacity:.85; } 50% { transform: scale(1.06); opacity:1; } }
        .outdoor-atlas .lw-cloud {
          position: absolute; height: 40px; border-radius: 99px;
          background: linear-gradient(180deg, oklch(0.95 0.02 250 / 0.13), oklch(0.85 0.02 250 / 0.05));
          filter: blur(2px); animation: lw-drift linear infinite;
        }
        .outdoor-atlas .lw-cloud::before, .outdoor-atlas .lw-cloud::after { content:''; position:absolute; background: inherit; border-radius:50%; }
        .outdoor-atlas .lw-cloud::before { width:60%; height:160%; left:10%; top:-50%; }
        .outdoor-atlas .lw-cloud::after  { width:50%; height:140%; right:8%; top:-40%; }
        @keyframes lw-drift { from { transform: translateX(-30vw); } to { transform: translateX(120vw); } }
        .outdoor-atlas .lw-drop {
          position: absolute; width: 1px; height: 26px;
          background: linear-gradient(180deg, transparent, oklch(0.78 0.08 220 / 0.55));
          animation: lw-rain linear infinite; opacity: .6;
        }
        @keyframes lw-rain { from { transform: translateY(-40px); } to { transform: translateY(110vh); } }
        .outdoor-atlas .lw-flake {
          position: absolute; width: 4px; height: 4px; border-radius: 50%;
          background: oklch(0.95 0.01 250 / 0.7); animation: lw-snow linear infinite; box-shadow: 0 0 4px white;
        }
        @keyframes lw-snow { from { transform: translateY(-20px); } to { transform: translateY(110vh) translateX(40px); } }
        .outdoor-atlas .lw-haze {
          position: absolute; left:0; right:0; bottom:0; height: 140px;
          background: linear-gradient(180deg, transparent, oklch(0.85 0.16 60 / 0.08));
          animation: lw-haze 6s ease-in-out infinite;
        }
        @keyframes lw-haze { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }

        /* Stack: anything that's not a backdrop layer rides above. */
        .outdoor-atlas > *:not(.atmos):not(.grid-overlay):not(.live-weather) { position: relative; z-index: 1; }

        /* Sweeping color/border overrides for light surfaces → dark glass. */
        .outdoor-atlas .bg-white,
        .outdoor-atlas .bg-\\[\\#f9fafc\\],
        .outdoor-atlas .bg-\\[\\#f5f6fb\\] { background-color: oklch(0.20 0.04 255 / 0.55) !important; backdrop-filter: blur(10px); }
        .outdoor-atlas .bg-white\\/95,
        .outdoor-atlas .bg-white\\/85 { background-color: oklch(0.18 0.04 255 / 0.6) !important; }
        .outdoor-atlas .bg-\\[\\#f6f7fb\\] { background-color: transparent !important; }
        .outdoor-atlas .bg-\\[\\#fafbff\\],
        .outdoor-atlas .bg-\\[\\#eef1f8\\] { background-color: oklch(0.22 0.05 255 / 0.5) !important; }
        .outdoor-atlas .bg-\\[\\#fffcf3\\],
        .outdoor-atlas .bg-\\[\\#fdf6e0\\],
        .outdoor-atlas .bg-\\[\\#fff8d8\\] { background-color: oklch(0.18 0.04 255 / 0.6) !important; }
        .outdoor-atlas .bg-\\[\\#fffbea\\],
        .outdoor-atlas .bg-\\[\\#fff4d0\\] { background-color: oklch(0.22 0.05 80 / 0.18) !important; }
        .outdoor-atlas .bg-\\[\\#faf5ff\\] { background-color: oklch(0.22 0.06 300 / 0.30) !important; }

        .outdoor-atlas .text-\\[\\#121726\\] { color: var(--ink) !important; }
        .outdoor-atlas .text-\\[\\#39415a\\] { color: var(--ink-dim) !important; }
        .outdoor-atlas .text-\\[\\#6b7388\\] { color: var(--ink-faint) !important; }
        .outdoor-atlas .text-\\[\\#39415a\\]\\!,
        .outdoor-atlas .text-\\[\\#1a150a\\] { color: var(--ink) !important; }
        .outdoor-atlas .text-\\[\\#7a6c3d\\],
        .outdoor-atlas .text-\\[\\#8a7330\\],
        .outdoor-atlas .text-\\[\\#6e5e2c\\],
        .outdoor-atlas .text-\\[\\#3c2f0a\\],
        .outdoor-atlas .text-\\[\\#2a1f07\\] { color: var(--ink-dim) !important; }
        .outdoor-atlas .text-\\[\\#9aa1b3\\] { color: var(--ink-faint) !important; }

        .outdoor-atlas .border-\\[\\#e3e6ef\\],
        .outdoor-atlas .border-\\[\\#eef0f5\\],
        .outdoor-atlas .border-\\[\\#c9cedb\\],
        .outdoor-atlas .border-\\[\\#f0e6c6\\],
        .outdoor-atlas .border-\\[\\#e4d9a8\\],
        .outdoor-atlas .border-\\[\\#f0dd95\\] { border-color: var(--line-soft) !important; }

        /* Hero h1 — editorial display */
        .outdoor-atlas h1.display-hero {
          font-family: 'Instrument Serif', serif !important; font-weight: 400 !important;
          letter-spacing: -0.025em !important; color: var(--ink);
        }
        .outdoor-atlas .accent-em { color: var(--accent); font-style: italic; }

        /* Profile toggle — glow chips */
        .outdoor-atlas .profile-chip-active { box-shadow: 0 0 22px var(--p-color, oklch(0.88 0.18 85 / 0.6)) !important; }

        /* Make the gradient strip at top of page a thin atmospheric line */
        .outdoor-atlas .gradient-strip { opacity: 0.55; }

        /* Animations preserved from prior version. */
        @keyframes leaderboardRowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .leaderboard-row { opacity: 0; animation: leaderboardRowIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        @keyframes medalPulse {
          0%, 100% { transform: scale(1) rotate(0deg); }
          30%      { transform: scale(1.15) rotate(-6deg); }
          60%      { transform: scale(1.1) rotate(4deg); }
        }
        .medal { display: inline-block; animation: medalPulse 2.8s ease-in-out 0.6s 2; }
        @keyframes statCount { from { opacity: 0.2; } to { opacity: 1; } }
        .stat-value { animation: statCount 0.8s ease-out; }
        @keyframes takeFade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .hero-take { animation: takeFade 0.6s ease-out; }
        @keyframes profileCardIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .profile-card { opacity: 0; animation: profileCardIn 0.55s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .profile-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px -10px oklch(0 0 0 / 0.4); transition: transform 0.18s, box-shadow 0.18s; }
      `}</style>

      <div className="atmos" aria-hidden="true" />
      <div className="grid-overlay" aria-hidden="true" />
      <LiveWeather profile={profileId} leaderRegion={visibleRegions[0]} />

      <div className="h-1 bg-gradient-to-r from-[#e45c3a] via-[#f2b046] to-[#0e8f74] gradient-strip" />

      {/* KOUT-7 station bar */}
      <div className="bg-gradient-to-b from-[#0d1019] to-[#121726] border-b border-[#1c2033] shadow-sm">
        <div className="max-w-[1320px] mx-auto px-7 py-3 flex items-center gap-4">
          <span className="font-mono text-lg font-bold tracking-widest px-3 py-1 rounded text-white"
                style={{ background: 'linear-gradient(180deg,#e45c3a,#c44a2a)' }}>KOUT·7</span>
          <span className="w-px h-5 bg-[#2a3050]" />
          <span className="text-base text-[#d4d8e6]">The <strong className="text-white font-bold">Outdoor&nbsp;Hours</strong> Report</span>
          <button
            type="button"
            onClick={() => setTutorialOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#2a3050] bg-[#1c2033] text-[#d4d8e6] text-xs font-bold uppercase tracking-wider hover:bg-[#262d4a] hover:text-white transition-colors"
          >
            🎓 Tour
          </button>
          <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[#ff4d4d]">
            <span className="w-2 h-2 rounded-full bg-[#ff2a2a] animate-pulse" style={{ boxShadow: '0 0 0 4px rgba(255,42,42,0.25)' }} />
            On the air
          </span>
        </div>
      </div>

      {tutorialOpen && <Tutorial onClose={closeTutorial} />}

      {/* Global profile toggle — defines what "good to go outside" means. */}
      {payload.profiles && payload.profiles.length > 0 && (
        <div className="bg-white border-b border-[#e3e6ef] shadow-sm">
          <div className="max-w-[1320px] mx-auto px-7 py-3 flex items-center gap-3 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388] mr-1">
              "Good to go outside" =
            </span>
            <div className="inline-flex flex-wrap gap-1.5 p-1 bg-[#f5f6fb] rounded-lg border border-[#e3e6ef]">
              {payload.profiles.map(p => {
                const active = p.id === profileId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProfileId(p.id)}
                    title={p.desc}
                    className={`px-3 py-1.5 rounded-md text-sm font-bold transition-colors ${active ? 'bg-[#121726] text-white shadow-sm' : 'text-[#39415a] hover:bg-white'}`}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                key="custom"
                type="button"
                onClick={() => setProfileId(CUSTOM_PROFILE_ID)}
                title="Tune your own thresholds"
                className={`px-3 py-1.5 rounded-md text-sm font-bold transition-colors ${profileId === CUSTOM_PROFILE_ID ? 'bg-[#7c3aed] text-white shadow-sm' : 'text-[#39415a] hover:bg-white'}`}
              >
                ✨ Custom
              </button>
            </div>
            <span className="text-sm text-[#6b7388] hidden md:inline-block">
              {profileId === CUSTOM_PROFILE_ID
                ? 'Tune the sliders below to define your own ideal day.'
                : payload.profiles.find(p => p.id === profileId)?.desc}
            </span>
          </div>
          {profileId === CUSTOM_PROFILE_ID && (
            <CustomProfileDrawer
              rule={customRule}
              onChange={setCustomRule}
              computing={customComputing}
              stale={customStale}
              onRecompute={recomputeCustom}
            />
          )}
        </div>
      )}

      {/* Hero */}
      <header className="max-w-[1320px] mx-auto px-7 pt-12 pb-4">
        <div className="inline-flex items-center gap-3 px-4 py-2 bg-white border border-[#e3e6ef] rounded-full text-sm font-semibold text-[#39415a] shadow-sm">
          {registryOrder(payload).filter(r => payload.region_registry?.[r]?.default_on).map((r, i, arr) => (
            <span key={r} className="inline-flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ background: registryColor(payload, r, i), boxShadow: `0 0 0 4px ${registryColor(payload, r, i)}33` }} />
              {registryLabel(payload, r)}
              {i < arr.length - 1 && <span className="text-[#6b7388] font-medium ml-1">vs.</span>}
            </span>
          ))}
        </div>
        <h1 className="display-hero mt-6 text-[clamp(56px,8vw,132px)] tracking-tight leading-[0.95]">
          Where is the weather <span className="accent-em">actually</span> better?
        </h1>
        <p className="mt-4 max-w-[760px] text-xl leading-snug text-[#39415a]">
          We counted every hour of the last <strong className="text-[#121726]">{rangeBadge}</strong> and asked one simple question — <em className="text-[#121726]">was it comfortable to be outside?</em>
          Flip the time range, toggle counties to compare, click any dot to drop down to the days and hours behind it.
        </p>
        {payload.pubdate && (
          <p className="mt-2 text-xs uppercase tracking-wider font-bold text-[#6b7388]">
            Data updated {new Date(payload.pubdate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
          </p>
        )}

        {/* Leaderboard stats */}
        <div className="flex gap-4 mt-8 flex-wrap">
          {leaderboard.map((r, i) => (
            <div key={r.region} className={`px-5 py-4 bg-white border border-[#e3e6ef] rounded-xl shadow-sm min-w-[180px] border-t-[3px] ${hasDirection && i === 0 && leaderboard.length >= 2 ? 'bg-gradient-to-b from-white to-[#fff8d8]' : ''}`}
                 style={{ borderTopColor: r.color }}>
              <div className="text-3xl font-extrabold tabular-nums text-[#121726] leading-tight">{fmtValue(r.value, meta.unit)}</div>
              <div className="text-xs uppercase tracking-wider font-bold mt-1" style={{ color: r.color }}>
                {r.label.replace(/\s*County/, '')}{hasDirection && i === 0 && leaderboard.length >= 2 ? ' ★' : ''}
              </div>
            </div>
          ))}
          <div className="px-5 py-4 bg-gradient-to-b from-[#f7f8fb] to-[#eef1f8] border border-[#e3e6ef] rounded-xl shadow-sm min-w-[130px]">
            <div className="text-3xl font-extrabold tabular-nums text-[#121726] leading-tight">{rangeBadge}</div>
            <div className="text-xs uppercase tracking-wider font-bold mt-1 text-[#6b7388]">Time range</div>
          </div>
        </div>

        {/* Quick Take */}
        <div className="mt-6 p-5 bg-gradient-to-br from-white to-[#fafbff] border border-[#e3e6ef] border-l-[6px] border-l-[#4055f1] rounded-xl shadow-md max-w-[1020px] text-xl leading-snug text-[#121726]">
          <span className="inline-block mr-3 px-3 py-1 rounded-full bg-[#4055f1] text-white text-xs font-bold uppercase tracking-widest align-middle">Quick take</span>
          <span dangerouslySetInnerHTML={{ __html: takeawayHtml }} />
          {auxHtml && <div className="mt-3 text-base text-[#39415a]" dangerouslySetInnerHTML={{ __html: auxHtml }} />}
        </div>

        {payload.summaries?.range_overview?.[tag] && (
          <div className="mt-3 p-4 bg-gradient-to-br from-[#fffbea] to-[#fff4d0] border border-[#f0dd95] border-l-[6px] border-l-[#d97706] rounded-xl shadow-sm max-w-[1020px] text-base leading-relaxed text-[#3c2f0a]">
            <span className="inline-block mr-3 px-3 py-1 rounded-full bg-[#d97706] text-white text-[11px] font-bold uppercase tracking-widest align-middle">KOUT·7 writer</span>
            {payload.summaries.range_overview[tag]}
          </div>
        )}

        {/* County Leaderboard — ranked by good-for-outdoors hours */}
        <Leaderboard payload={payload} grain={grain} tag={tag} profileId={profileId} customResults={customResults} />
      </header>

      {/* Controls — sticky on scroll so range/grain/metric stay reachable while exploring deep dive */}
      <section className="max-w-[1320px] mx-auto mt-7 px-5 py-4 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85 border border-[#e3e6ef] rounded-xl shadow-sm flex flex-col gap-3 relative sticky top-0 z-30">
        <span className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l bg-gradient-to-b from-[#e45c3a] to-[#0e8f74]" />

        <div className="flex gap-4 items-end flex-wrap">
          <div className="flex flex-col gap-1.5 min-w-[200px]">
            <span className="text-xs font-bold uppercase tracking-wider text-[#6b7388]">Time range</span>
            <div className="inline-flex border border-[#e3e6ef] rounded-lg overflow-hidden bg-[#fafbff]">
              {RANGE_ORDER.map(r => {
                const active = r.tag === tag;
                const disabled = !availableTags.has(r.tag);
                return (
                  <button key={r.tag} type="button" disabled={disabled}
                          title={disabled ? 'Dataset not yet available' : `Switch to ${r.label}`}
                          className={`text-sm font-semibold px-4 py-2.5 border-r border-[#e3e6ef] last:border-r-0 transition-colors tabular-nums whitespace-nowrap ${active ? 'bg-[#121726] text-white' : 'text-[#39415a] hover:bg-[#eef1f8] hover:text-[#121726]'} ${disabled ? 'opacity-35 cursor-not-allowed' : 'cursor-pointer'}`}
                          onClick={() => !disabled && !active && setTag(r.tag)}>
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex flex-col gap-1.5 min-w-[200px]">
            <span className="text-xs font-bold uppercase tracking-wider text-[#6b7388]">Show by</span>
            <select className="text-base font-semibold px-4 py-3 border border-[#e3e6ef] rounded-lg bg-white text-[#121726] cursor-pointer hover:border-[#c9cedb] focus:outline-none focus:border-[#4055f1] focus:ring-2 focus:ring-[#4055f1]/20"
                    value={grain} onChange={e => setGrain(e.target.value as Grain)}>
              <option value="yearly">Year</option>
              <option value="monthly">Month</option>
              <option value="daily">Day</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 min-w-[320px] flex-1">
            <span className="text-xs font-bold uppercase tracking-wider text-[#6b7388]">Tell me about…</span>
            <select className="text-base font-semibold px-4 py-3 border border-[#e3e6ef] rounded-lg bg-white text-[#121726] cursor-pointer hover:border-[#c9cedb] focus:outline-none focus:border-[#4055f1] focus:ring-2 focus:ring-[#4055f1]/20"
                    value={metricKey} onChange={e => setMetricKey(e.target.value)}>
              {payload.metrics.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 justify-end" title={grain === 'yearly' ? 'Year-over-year only meaningful with monthly or daily grain' : 'One line per year for the first selected county'}>
            <span className="text-xs font-bold uppercase tracking-wider text-[#6b7388]">Year-over-year</span>
            <button
              type="button"
              disabled={grain === 'yearly'}
              onClick={() => setYoy(v => !v)}
              className={`px-4 py-3 rounded-lg text-sm font-bold border transition-colors ${grain === 'yearly' ? 'bg-[#f5f6fb] text-[#9aa1b3] border-[#e3e6ef] cursor-not-allowed' : yoy ? 'bg-[#121726] text-white border-[#121726] shadow-sm' : 'bg-white text-[#39415a] border-[#e3e6ef] hover:border-[#c9cedb]'}`}
            >
              {yoy && grain !== 'yearly' ? '📅 ON' : '📅 Off'}
            </button>
          </label>
        </div>

        <div className="flex items-center gap-3 flex-wrap pt-3 border-t border-dashed border-[#e3e6ef]">
          <span className="text-xs font-bold uppercase tracking-wider text-[#6b7388]">Compare counties</span>
          <div className="inline-flex gap-2 flex-wrap">
            {registryOrder(payload).map((r, idx) => {
              const info = payload.region_registry?.[r];
              const color = registryColor(payload, r, idx);
              const active = regionsOn.has(r);
              const isExperimental = info && !info.default_on;
              return (
                <button key={r} type="button" onClick={() => toggleRegion(r)}
                        className={`inline-flex items-center gap-2 px-4 py-2 border-2 rounded-full text-sm font-semibold cursor-pointer transition-all select-none ${
                          active ? 'bg-white text-[#121726]' : 'bg-white text-[#6b7388] hover:border-[#c9cedb]'
                        }`}
                        style={{
                          borderColor: active ? color : '#e3e6ef',
                          backgroundColor: active ? `${color}11` : 'white',
                          boxShadow: active ? '0 2px 6px rgba(0,0,0,0.04)' : 'none',
                        }}>
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: color, boxShadow: active ? `0 0 0 3px ${color}33` : 'none' }} />
                  {registryLabel(payload, r)}
                  {isExperimental && <span className="text-[11.5px] text-[#6b7388] font-medium">{active ? '' : '(tap to compare)'}</span>}
                </button>
              );
            })}
          </div>
          <span className="ml-auto text-sm font-medium text-[#6b7388]">Tip: click a dot — or a row — to drill deeper.</span>
        </div>
      </section>

      {/* Rules card — dynamic per active profile */}
      {(() => {
        const activeP = activeProfile(payload, profileId);
        const isCustom = profileId === CUSTOM_PROFILE_ID;
        const rule: ProfileRule = isCustom ? customRule : (activeP?.rule ?? payload.rule);
        const labelOverride = isCustom ? '✨ Custom' : activeP?.label;
        const descOverride = isCustom ? 'Your tuned thresholds — adjust the sliders at the top of the page.' : activeP?.desc;
        const cards: { color: string; bg: string; ink: string; icon: string; name: string; val: string; sub: string }[] = [
          { color: '#f5b041', bg: '#fff6e0', ink: '#8a5b0e', icon: '☀', name: 'Daytime',          val: 'Sun is up',                                              sub: "Nighttime hours don’t count." },
          { color: '#e85d3e', bg: '#fdeee8', ink: '#a8311a', icon: '🌡', name: 'Comfortable temp', val: `${rule.temp_min_f}°–${rule.temp_max_f}°F`,            sub: `That’s ${rule.temp_min_c}°–${rule.temp_max_c}°C.` },
          { color: '#9b59b6', bg: '#f4ecf7', ink: '#6d2d85', icon: '⛅', name: 'Safe UV',          val: `Index ≤ ${rule.uv_max}`,                            sub: 'Above that and dermatologists say cover up.' },
          { color: '#3498db', bg: '#eaf2f9', ink: '#1f5a82', icon: '☂', name: 'Not raining',      val: `≤ ${rule.rain_max_mm_h} mm/hr`,                     sub: "Light drizzle is OK — a downpour isn’t." },
        ];
        if (rule.cloud_max_pct != null)    cards.push({ color: '#7f8c8d', bg: '#eef0f2', ink: '#4a5557', icon: '☁', name: 'Not overcast', val: `Cloud ≤ ${rule.cloud_max_pct}%`,    sub: "Socked-in skies kill the vibe even when it’s warm." });
        if (rule.humidity_max_pct != null) cards.push({ color: '#16a085', bg: '#e6f4f1', ink: '#0e6655', icon: '💧', name: 'Not muggy',    val: `Humidity ≤ ${rule.humidity_max_pct}%`, sub: "Above this, sweat can’t evaporate and the air feels heavy." });
        if (rule.aqi_max != null)          cards.push({ color: '#dc2626', bg: '#fdecec', ink: '#991b1b', icon: '🌫', name: 'Clean air',    val: `US AQI ≤ ${rule.aqi_max}`,           sub: "Pre-Aug-2022 hours don’t fail this rule (no AQ data)." });
        const n = cards.length;
        return (
          <section className="max-w-[1320px] mx-auto mt-5 px-7 pt-6 pb-7 bg-gradient-to-b from-[#fffcf3] to-[#fdf6e0] border border-[#f0e6c6] rounded-xl shadow-sm text-[#3c2f0a]">
            <header className="flex items-end justify-between gap-6 flex-wrap pb-4 border-b border-dashed border-[#e4d9a8]">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#8a7330]">{labelOverride ?? 'Rules'}</div>
                <h2 className="mt-1 text-[26px] font-extrabold tracking-tight text-[#2a1f07]">What counts as a comfortable hour?</h2>
                {descOverride && <p className="mt-1 text-sm text-[#7a6c3d]">{descOverride}</p>}
              </div>
              <div className="inline-flex items-center gap-3.5 px-[18px] py-2.5 bg-[#3c2f0a] text-[#fbe389] rounded-xl shadow-md">
                <span className="font-mono text-2xl font-extrabold tracking-wider text-white">{n} of {n}</span>
                <span className="text-xs leading-tight font-semibold text-[#fbe389]">must pass<br />for the hour to count</span>
              </div>
            </header>

            <ol className="mt-5 grid gap-3.5 items-stretch list-none p-0 lg:grid-cols-3 md:grid-cols-2 grid-cols-1">
              {cards.map((c, i) => (
                <li key={`r-${i}`} className="p-[18px] bg-white border border-[#f0e6c6] rounded-2xl shadow-sm flex flex-col gap-1.5 border-t-4 min-h-[180px]" style={{ borderTopColor: c.color }}>
                  <div className="w-[52px] h-[52px] rounded-xl inline-flex items-center justify-center text-[28px] leading-none" style={{ background: c.bg, color: c.ink }}>{c.icon}</div>
                  <div className="text-[11px] font-bold uppercase tracking-[0.1em] mt-1" style={{ color: c.color }}>{c.name}</div>
                  <div className="text-[22px] font-extrabold text-[#1a150a] leading-tight tracking-tight">{c.val}</div>
                  <div className="text-[13.5px] text-[#6e5e2c] leading-snug mt-0.5">{c.sub}</div>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm italic text-[#7a6c3d]">Each county averages its sample neighborhoods. Every hour is scored independently. Switch profiles at the top of the page.</p>
          </section>
        );
      })()}

      {/* Chart */}
      <main className="max-w-[1320px] mx-auto mt-5 p-3 bg-white border border-[#e3e6ef] rounded-xl shadow-md" style={{ height: 'min(70vh, 640px)' }}>
        <div ref={chartRef} className="w-full h-full" />
      </main>

      {/* Region Deep Dive — every metric, focus on one region with overlays */}
      <RegionDeepDive payload={payload} tag={tag} grain={grain} profileId={profileId} plotlyReady={plotlyReady} customResults={customResults} />

      {/* Detail panel */}
      {drillStack.length > 0 && (
        <DetailPanel
          stack={drillStack}
          onDrillTo={drillTo}
          onClose={closeDetail}
          onRowDrill={(detailGrain, rawX) => {
            const n = nextStepFor(detailGrain, rawX);
            if (n) drillFurther(n.grain, n.bucket, n.label);
          }}
          fullscreen={fullscreen}
          setFullscreen={setFullscreen}
          loading={detailLoading}
          result={detailResult}
          payload={payload}
          metricLabel={meta.label}
          metricUnit={meta.unit}
        />
      )}

      {/* Meet the Counties — per-region LLM-written character profiles */}
      {payload.summaries?.region_profiles && Object.keys(payload.summaries.region_profiles).length > 0 && (
        <section className="max-w-[1320px] mx-auto mt-5">
          <header className="px-1 mb-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388]">Meet the Counties</div>
            <h3 className="mt-1 text-[22px] font-extrabold tracking-tight text-[#121726]">When to go, when to stay home</h3>
            <p className="text-sm text-[#6b7388] mt-0.5">Ten-year personality profiles, written by KOUT-7&rsquo;s in-house weather writer.</p>
          </header>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {(payload.region_order || Object.keys(payload.regions))
              .filter(r => payload.summaries?.region_profiles?.[r])
              .map((r, idx) => {
                const profile = payload.summaries!.region_profiles![r];
                const color = registryColor(payload, r, idx);
                const ink = registryInk(payload, r);
                const label = registryLabel(payload, r);
                return (
                  <article
                    key={r}
                    className="bg-white border border-[#e3e6ef] rounded-xl shadow-sm overflow-hidden flex flex-col profile-card"
                    style={{ animationDelay: `${idx * 70}ms` }}
                  >
                    <header className="px-4 py-3 border-b border-[#e3e6ef] flex items-center gap-2.5" style={{ background: `${color}26`, borderBottomColor: `${color}55` }}>
                      <span className="w-3 h-3 rounded-full" style={{ background: color, boxShadow: `0 0 0 3px ${color}33` }} />
                      <span className="font-bold text-[15px] leading-tight" style={{ color }}>{label}</span>
                    </header>
                    <div className="px-4 py-4 flex flex-col gap-3 text-[14px] leading-relaxed text-[#39415a] flex-1">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#0e8f74] mb-1">★ Best time</div>
                        <div className="text-[#121726]">{profile.best_time}</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#4055f1] mb-1">＋ Strengths</div>
                        <div className="text-[#121726]">{profile.strengths}</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#c44a2a] mb-1">⚠ Watch out for</div>
                        <div className="text-[#121726]">{profile.watch_out}</div>
                      </div>
                    </div>
                  </article>
                );
              })}
          </div>
        </section>
      )}

      {/* Notes */}
      <section className="max-w-[1320px] mx-auto mt-5 mb-8 px-8 py-7 bg-white border border-[#e3e6ef] rounded-xl shadow-sm text-[#39415a] text-base">
        <h3 className="text-xl font-bold text-[#121726] mb-3 tracking-tight">How to read the chart</h3>
        <ul className="list-disc pl-6 space-y-2 leading-relaxed">
          <li><strong className="text-[#121726]">Each dot is a block of time</strong> — a year, month, or day depending on what you picked above. Change the <strong>Time range</strong> to zoom out 1, 5, 10 or 30 years.</li>
          <li><strong className="text-[#121726]">Toggle counties</strong> in the Compare Counties row to layer more regions on the same chart. The drill-in table adapts — one column group per visible region.</li>
          <li>Every chart dot is clickable. From the table you can keep going — <strong className="text-[#121726]">monthly → daily → hourly</strong> — and breadcrumbs let you walk back up.</li>
        </ul>
        <h3 className="text-xl font-bold text-[#121726] mb-3 mt-6 tracking-tight">Where the numbers come from</h3>
        <ul className="list-disc pl-6 space-y-2 leading-relaxed">
          <li>Hourly historical weather data from the global ERA5 record — updated to within about five days of today.</li>
          <li>Each county averages three sample neighborhoods. UV is estimated from solar angle × cloud cover.</li>
          <li>Extra counties (San Francisco, Snohomish) are experimental — data coverage may lag the core two.</li>
        </ul>
        <div className="flex justify-between items-center gap-3 mt-5 pt-4 border-t border-[#e3e6ef] text-sm text-[#6b7388] flex-wrap">
          <span>KOUT·7 Outdoor Hours · open weather data · {rangeBadge} · {visibleRegions.length} counties</span>
          <span className="px-3 py-1.5 border border-[#e3e6ef] rounded-full bg-[#f4f5fa] text-[#39415a] font-semibold tabular-nums">{tag} · {payload.grains.daily.regions[visibleRegions[0]]?.x.length ?? 0} days</span>
        </div>
      </section>
    </div>
  );
}

export default OutdoorHoursPage;

// ── Live Weather Layer ──
// A fixed-position decorative backdrop that shifts mood (sun / rain / clouds / snow / haze)
// based on the active profile and the first-visible region's climate group. Cosmetic only.

interface LiveWeatherProps { profile: string; leaderRegion: string | undefined; }

function LiveWeather({ profile, leaderRegion }: LiveWeatherProps) {
  const mood = useMemo(() => {
    if (profile === 'cool_cloudy') return 'cloud';
    if (profile === 'all_weather') return 'rain';
    if (profile === 'sun_seeker') return 'sun';
    if (!leaderRegion) return 'sun';
    if (/king|snohomish/.test(leaderRegion)) return 'rain';
    if (/maui/.test(leaderRegion)) return 'sun';
    if (/florida|fl$|miami|charlotte_fl|st_johns/.test(leaderRegion)) return 'haze';
    if (/westchester/.test(leaderRegion) && new Date().getMonth() < 3) return 'snow';
    return 'sun';
  }, [profile, leaderRegion]);

  const layers = useMemo(() => {
    const clouds = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      top: 40 + Math.random() * 280,
      width: 200 + Math.random() * 250,
      dur: 60 + Math.random() * 80,
      delay: -Math.random() * 80,
      opacity: mood === 'cloud' ? 0.9 : (mood === 'rain' ? 0.7 : 0.35),
    }));
    const drops = mood === 'rain' ? Array.from({ length: 70 }, () => ({
      left: Math.random() * 100,
      dur: 0.6 + Math.random() * 0.8,
      delay: Math.random() * 1.4,
      opacity: 0.3 + Math.random() * 0.4,
    })) : [];
    const flakes = mood === 'snow' ? Array.from({ length: 60 }, () => ({
      left: Math.random() * 100,
      dur: 6 + Math.random() * 8,
      delay: Math.random() * 8,
      size: 2 + Math.random() * 4,
    })) : [];
    return { sun: mood === 'sun' || mood === 'haze', clouds, drops, flakes, haze: mood === 'haze' };
  }, [mood]);

  return (
    <div className="live-weather" aria-hidden="true">
      {layers.sun && <div className="lw-sun" />}
      {layers.clouds.map(c => (
        <div key={c.id} className="lw-cloud"
             style={{ top: c.top, width: c.width, animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s`, opacity: c.opacity }} />
      ))}
      {layers.drops.map((d, i) => (
        <div key={i} className="lw-drop"
             style={{ left: `${d.left}%`, animationDuration: `${d.dur}s`, animationDelay: `${d.delay}s`, opacity: d.opacity }} />
      ))}
      {layers.flakes.map((f, i) => (
        <div key={i} className="lw-flake"
             style={{ left: `${f.left}%`, width: f.size, height: f.size, animationDuration: `${f.dur}s`, animationDelay: `${f.delay}s` }} />
      ))}
      {layers.haze && <div className="lw-haze" />}
    </div>
  );
}

// ── Tutorial / Onboarding Tour ──

interface TutorialStep { icon: string; title: string; body: React.ReactNode; }

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    icon: '👋',
    title: 'Welcome to KOUT-7 Outdoor Hours',
    body: (
      <>
        <p>We took every hour of the last <strong>10 years</strong> of weather + air-quality data across <strong>12 counties</strong> (Bay Area, Seattle, Florida coasts, NYC, Maui, Sofia, Gabrovo) and asked one question:</p>
        <p className="mt-3 text-lg italic text-[#7c3aed]">"Was it good to go outside?"</p>
        <p className="mt-3">This 6-step tour shows you the controls. You can re-launch it anytime from the <strong>🎓 Tour</strong> button at the top.</p>
      </>
    ),
  },
  {
    icon: '☀',
    title: 'Pick a definition of "good"',
    body: (
      <>
        <p>An hour scores when it passes a checklist: <strong>daytime</strong>, comfortable temp, low UV, not raining, not overcast, not muggy, clean air.</p>
        <p className="mt-3">The <strong>profile bar</strong> at the top of the page lets you pick one of 5 presets:</p>
        <ul className="mt-2 ml-5 list-disc space-y-0.5">
          <li><strong>🔆 Sun Seeker</strong> — strict beach-day rules</li>
          <li><strong>☀ Goldilocks</strong> — balanced, the default</li>
          <li><strong>🌤 Classic</strong> — original 4-rule, no cloud/humidity</li>
          <li><strong>🌥 Cool & Cloudy</strong> — likes brisk overcast days</li>
          <li><strong>🥾 All-Weather</strong> — only true extremes count</li>
        </ul>
        <p className="mt-3">The chart, leaderboard, and rule cards all swap instantly to the active profile.</p>
      </>
    ),
  },
  {
    icon: '✨',
    title: 'Or build your own with Custom',
    body: (
      <>
        <p>Click <strong>✨ Custom</strong> in the profile bar to open a slider drawer. Tune any threshold — temp range, UV, rain, optional caps for cloud / humidity / AQI.</p>
        <p className="mt-3">The browser re-aggregates 10 years of hourly data against your rule on the fly. The chart updates to show <em>your</em> definition of good outdoor hours.</p>
        <p className="mt-3 text-sm text-[#6b7388]">Pre-Aug 2022 hours don't have AQ data, so the AQI rule doesn't penalize older history.</p>
      </>
    ),
  },
  {
    icon: '🎛',
    title: 'Compare counties + drill in',
    body: (
      <>
        <p>The <strong>Controls bar</strong> (sticky as you scroll) sets:</p>
        <ul className="mt-2 ml-5 list-disc space-y-0.5">
          <li><strong>Time range</strong> — 1mo / 1yr / 5yr / 10yr</li>
          <li><strong>Show by</strong> — Year / Month / Day</li>
          <li><strong>Tell me about…</strong> — pick any of 17 metrics</li>
          <li><strong>📅 YoY</strong> — fold the chart into one line per year (great for spotting seasonal trends)</li>
          <li><strong>Compare counties</strong> — toggle which counties show on the chart</li>
        </ul>
        <p className="mt-3">Click any dot in the main chart to <strong>drill</strong> from years → months → days → hours.</p>
      </>
    ),
  },
  {
    icon: '🔬',
    title: 'Region Deep Dive',
    body: (
      <>
        <p>Below the main chart: <strong>every metric for one county</strong>, rendered as 17 mini-charts in a grid.</p>
        <p className="mt-3">Pick the <strong>Focus</strong> county at the top of that section, then click any <strong>Overlay</strong> chip to add a comparison county to <em>every</em> mini-chart at once. Great for "how does Sofia's air quality compare to Miami's?".</p>
      </>
    ),
  },
  {
    icon: '🔗',
    title: 'Share any view',
    body: (
      <>
        <p>Every choice you make encodes into the URL — including custom profile thresholds. Copy the link to share or bookmark a specific view.</p>
        <p className="mt-3">Examples:</p>
        <ul className="mt-2 ml-5 list-disc text-sm font-mono break-all space-y-1">
          <li>?tag=last5y&metric=us_aqi_mean&profile=sun_seeker</li>
          <li>?profile=custom&cr=10,28,5,0.5,60,75,75&tag=last1y</li>
          <li>?regions=miami_dade_fl,sofia_bg&yoy=1</li>
        </ul>
        <p className="mt-3">That's the tour. Hit the <strong>🎓 Tour</strong> button anytime to re-watch it.</p>
      </>
    ),
  },
];

interface TutorialProps { onClose: () => void; }

function Tutorial({ onClose }: TutorialProps) {
  const [step, setStep] = useState(0);
  const max = TUTORIAL_STEPS.length;
  const cur = TUTORIAL_STEPS[step];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && step < max - 1) setStep(s => s + 1);
      if (e.key === 'ArrowLeft' && step > 0) setStep(s => s - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, max, onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-[#0d1019]/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-[640px] w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <header className="px-7 pt-7 pb-3 border-b border-[#eef0f5] flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#7c3aed] to-[#4055f1] inline-flex items-center justify-center text-3xl shrink-0">{cur.icon}</div>
          <div className="flex-1">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388]">Tour · Step {step + 1} of {max}</div>
            <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-[#121726]">{cur.title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close tour" className="text-[#9aa1b3] hover:text-[#121726] text-2xl leading-none p-1">×</button>
        </header>
        <div className="px-7 py-5 text-[15.5px] leading-relaxed text-[#39415a]">
          {cur.body}
        </div>
        <footer className="px-7 py-4 border-t border-[#eef0f5] bg-[#f9fafc] flex items-center gap-3">
          <div className="flex gap-1.5 mr-auto">
            {Array.from({ length: max }).map((_, i) => (
              <button key={i} type="button" onClick={() => setStep(i)} aria-label={`Go to step ${i + 1}`} className={`h-2 rounded-full transition-all ${i === step ? 'bg-[#7c3aed] w-6' : 'bg-[#e3e6ef] w-2 hover:bg-[#c9cedb]'}`} />
            ))}
          </div>
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm font-bold text-[#6b7388] hover:text-[#121726]">
            Skip
          </button>
          {step > 0 && (
            <button type="button" onClick={() => setStep(s => s - 1)} className="px-4 py-2 text-sm font-bold text-[#39415a] border border-[#e3e6ef] rounded-md hover:bg-white">
              ← Back
            </button>
          )}
          {step < max - 1 ? (
            <button type="button" onClick={() => setStep(s => s + 1)} className="px-4 py-2 text-sm font-bold text-white bg-[#7c3aed] rounded-md hover:bg-[#6d28d9] shadow-sm">
              Next →
            </button>
          ) : (
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-bold text-white bg-[#0e8f74] rounded-md hover:bg-[#0a755e] shadow-sm">
              Done ✓
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ── Custom Profile Drawer ──

interface CustomProfileDrawerProps {
  rule: ProfileRule;
  onChange: (r: ProfileRule) => void;
  computing: boolean;
  stale: boolean;
  onRecompute: () => void;
}

function CustomProfileDrawer({ rule, onChange, computing, stale, onRecompute }: CustomProfileDrawerProps) {
  const update = (patch: Partial<ProfileRule>) => onChange({ ...rule, ...patch });
  const ruleCount = 4 + (rule.cloud_max_pct != null ? 1 : 0) + (rule.humidity_max_pct != null ? 1 : 0) + (rule.aqi_max != null ? 1 : 0);

  return (
    <div className="bg-gradient-to-b from-[#faf5ff] to-white border-t border-[#e3e6ef]">
      <div className="max-w-[1320px] mx-auto px-7 py-4 grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {/* Temp range */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388]">🌡 Temp range</span>
          <div className="flex items-center gap-2">
            <input type="number" step={1} value={rule.temp_min_c} onChange={e => update({ temp_min_c: +e.target.value, temp_min_f: Math.round(+e.target.value * 9 / 5 + 32) })} className="w-16 px-2 py-1 border border-[#e3e6ef] rounded text-sm font-semibold" />
            <span className="text-sm text-[#6b7388]">to</span>
            <input type="number" step={1} value={rule.temp_max_c} onChange={e => update({ temp_max_c: +e.target.value, temp_max_f: Math.round(+e.target.value * 9 / 5 + 32) })} className="w-16 px-2 py-1 border border-[#e3e6ef] rounded text-sm font-semibold" />
            <span className="text-sm text-[#6b7388]">°C ({rule.temp_min_f}–{rule.temp_max_f}°F)</span>
          </div>
        </div>
        {/* UV */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388]">⛅ UV max</span>
          <input type="range" min={0} max={12} step={0.5} value={rule.uv_max} onChange={e => update({ uv_max: +e.target.value })} />
          <span className="text-sm font-semibold text-[#121726]">≤ {rule.uv_max}</span>
        </div>
        {/* Rain */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388]">☂ Rain max</span>
          <input type="range" min={0} max={5} step={0.1} value={rule.rain_max_mm_h} onChange={e => update({ rain_max_mm_h: +e.target.value })} />
          <span className="text-sm font-semibold text-[#121726]">≤ {rule.rain_max_mm_h.toFixed(1)} mm/hr</span>
        </div>
        {/* Cloud */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388] flex items-center gap-2">
            <input type="checkbox" checked={rule.cloud_max_pct != null} onChange={e => update({ cloud_max_pct: e.target.checked ? 85 : null })} />
            ☁ Cloud cap
          </label>
          {rule.cloud_max_pct != null ? (
            <>
              <input type="range" min={0} max={100} step={5} value={rule.cloud_max_pct} onChange={e => update({ cloud_max_pct: +e.target.value })} />
              <span className="text-sm font-semibold text-[#121726]">≤ {rule.cloud_max_pct}%</span>
            </>
          ) : <span className="text-sm text-[#9aa1b3] italic">no cloud constraint</span>}
        </div>
        {/* Humidity */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388] flex items-center gap-2">
            <input type="checkbox" checked={rule.humidity_max_pct != null} onChange={e => update({ humidity_max_pct: e.target.checked ? 80 : null })} />
            💧 Humidity cap
          </label>
          {rule.humidity_max_pct != null ? (
            <>
              <input type="range" min={0} max={100} step={5} value={rule.humidity_max_pct} onChange={e => update({ humidity_max_pct: +e.target.value })} />
              <span className="text-sm font-semibold text-[#121726]">≤ {rule.humidity_max_pct}%</span>
            </>
          ) : <span className="text-sm text-[#9aa1b3] italic">no humidity constraint</span>}
        </div>
        {/* AQI */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388] flex items-center gap-2">
            <input type="checkbox" checked={rule.aqi_max != null} onChange={e => update({ aqi_max: e.target.checked ? 100 : null })} />
            🌫 AQI cap
          </label>
          {rule.aqi_max != null ? (
            <>
              <input type="range" min={0} max={300} step={10} value={rule.aqi_max} onChange={e => update({ aqi_max: +e.target.value })} />
              <span className="text-sm font-semibold text-[#121726]">≤ {rule.aqi_max}</span>
            </>
          ) : <span className="text-sm text-[#9aa1b3] italic">no AQI constraint</span>}
        </div>
        {/* Recompute action */}
        <div className="flex flex-col gap-1.5 lg:col-span-1 xl:col-span-2 items-stretch">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388]">{ruleCount} of {ruleCount} must pass</span>
          <button
            type="button"
            disabled={computing}
            onClick={onRecompute}
            className={`px-5 py-2.5 rounded-lg text-sm font-bold border transition-colors ${computing ? 'bg-[#f5f6fb] text-[#9aa1b3] border-[#e3e6ef] cursor-wait' : stale ? 'bg-[#7c3aed] text-white border-[#7c3aed] hover:bg-[#6d28d9] shadow-sm' : 'bg-white text-[#7c3aed] border-[#7c3aed]'}`}
          >
            {computing ? '⏳ Computing…' : stale ? '🔁 Recompute (sliders changed)' : '✓ Up to date'}
          </button>
          <span className="text-xs text-[#6b7388]">
            Computes per-hour against {' '}
            <strong>10 years</strong> of hourly data in your browser.
            Pre-Aug-2022 hours have no AQ data → AQ rule is unconstrained for those hours.
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Region Deep Dive: per-region small-multiples with overlay support ──

interface RegionDeepDiveProps {
  payload: Payload;
  tag: string;
  grain: Grain;
  profileId: string;
  plotlyReady: boolean;
  customResults: CustomResults | null;
}

function RegionDeepDive({ payload, tag, grain, profileId, plotlyReady, customResults }: RegionDeepDiveProps) {
  const allRegions = registryOrder(payload).filter(r => payload.grains[grain].regions[r]);

  // Default focus = first region with data (usually santa_clara_ca).
  const [focus, setFocus] = useState<string>(() => allRegions[0] ?? '');
  const [overlays, setOverlays] = useState<Set<string>>(new Set());

  // If region list changes (e.g. tag swap) and focus is gone, reset.
  useEffect(() => {
    if (!allRegions.includes(focus) && allRegions.length) setFocus(allRegions[0]);
  }, [allRegions, focus]);

  const rangeLabel = RANGE_ORDER.find(r => r.tag === tag)?.label ?? tag;
  const focusLabel = registryLabel(payload, focus);

  const toggleOverlay = (r: string) => {
    setOverlays(prev => {
      const n = new Set(prev);
      if (n.has(r)) n.delete(r); else n.add(r);
      return n;
    });
  };

  if (!focus) return null;

  return (
    <section className="max-w-[1320px] mx-auto mt-5 px-7 pt-6 pb-7 bg-white border border-[#e3e6ef] rounded-xl shadow-md">
      <header className="flex items-end justify-between gap-6 flex-wrap pb-4 border-b border-[#eef0f5]">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#6b7388]">Region Deep Dive</div>
          <h2 className="mt-1 text-[26px] font-extrabold tracking-tight text-[#121726]">
            Every metric for <span style={{ color: registryColor(payload, focus, allRegions.indexOf(focus)) }}>{focusLabel}</span>
          </h2>
          <p className="mt-1 text-sm text-[#6b7388]">{rangeLabel} · {grain} grain · click any chip to overlay another county for direct comparison.</p>
        </div>
      </header>

      {/* Focus picker */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388] mr-1">Focus</span>
        {allRegions.map(r => {
          const active = r === focus;
          const c = registryColor(payload, r, allRegions.indexOf(r));
          return (
            <button
              key={r}
              type="button"
              onClick={() => { setFocus(r); setOverlays(prev => { const n = new Set(prev); n.delete(r); return n; }); }}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors border ${active ? 'text-white shadow-sm' : 'text-[#39415a] hover:bg-[#fafbff]'}`}
              style={active ? { background: c, borderColor: c } : { background: 'white', borderColor: '#e3e6ef' }}
            >
              <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${active ? '' : ''}`} style={{ background: c, boxShadow: active ? '0 0 0 2px white' : `0 0 0 2px ${c}33` }} />
              {registryLabel(payload, r).replace(/, [A-Z]{2}$/, '')}
            </button>
          );
        })}
      </div>

      {/* Overlay picker */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388] mr-1">Overlay</span>
        {allRegions.filter(r => r !== focus).map(r => {
          const active = overlays.has(r);
          const c = registryColor(payload, r, allRegions.indexOf(r));
          return (
            <button
              key={r}
              type="button"
              onClick={() => toggleOverlay(r)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors border ${active ? 'text-white shadow-sm' : 'text-[#39415a] hover:bg-[#fafbff]'}`}
              style={active ? { background: c, borderColor: c, opacity: 0.85 } : { background: 'white', borderColor: '#e3e6ef' }}
            >
              <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: c, boxShadow: `0 0 0 2px ${c}33` }} />
              {registryLabel(payload, r).replace(/, [A-Z]{2}$/, '')}
            </button>
          );
        })}
        {overlays.size > 0 && (
          <button type="button" onClick={() => setOverlays(new Set())} className="ml-1 px-2.5 py-1 text-xs font-bold text-[#6b7388] hover:text-[#121726]">
            clear
          </button>
        )}
      </div>

      {/* Mini-chart grid */}
      <div className="mt-5 grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {payload.metrics.map(m => (
          <MiniMetricChart
            key={m.key}
            payload={payload}
            grain={grain}
            metric={m}
            focus={focus}
            overlays={overlays}
            profileId={profileId}
            allRegions={allRegions}
            plotlyReady={plotlyReady}
            customResults={customResults}
          />
        ))}
      </div>
    </section>
  );
}

interface MiniMetricChartProps {
  payload: Payload;
  grain: Grain;
  metric: MetricMeta;
  focus: string;
  overlays: Set<string>;
  profileId: string;
  allRegions: string[];
  plotlyReady: boolean;
  customResults: CustomResults | null;
}

function MiniMetricChart({ payload, grain, metric, focus, overlays, profileId, allRegions, plotlyReady, customResults }: MiniMetricChartProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!plotlyReady || !ref.current || !window.Plotly) return;
    const grainData = payload.grains[grain];

    const buildTrace = (regionId: string, isFocus: boolean) => {
      const s = grainData.regions[regionId];
      if (!s) return null;
      const color = registryColor(payload, regionId, allRegions.indexOf(regionId));
      return {
        x: s.x,
        y: readSeries(payload, regionId, metric.key, profileId, grain, customResults),
        name: registryShort(payload, regionId),
        type: 'scatter',
        mode: isFocus ? 'lines' : 'lines',
        line: { width: isFocus ? 2.5 : 1.2, color },
        opacity: isFocus ? 1 : 0.55,
        hovertemplate: `<b>${registryShort(payload, regionId)}</b><br>%{x}<br>%{y:.2f} ${metric.unit}<extra></extra>`,
      };
    };

    const traces = [
      buildTrace(focus, true),
      ...Array.from(overlays).map(r => buildTrace(r, false)),
    ].filter(Boolean);

    const inter = 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    const display = "'Instrument Serif', Georgia, serif";
    const mono = "'JetBrains Mono', ui-monospace, monospace";
    const ink = '#f7f4eb', inkFaint = '#9c977d';
    const lineSoft = 'rgba(255,255,255,0.08)';
    const layout = {
      title: { text: metric.label, font: { family: display, size: 18, color: ink }, x: 0.02, xanchor: 'left', y: 0.96 },
      font: { family: inter, color: inkFaint, size: 11 },
      xaxis: { type: grain === 'yearly' ? 'linear' : 'date', showgrid: false, linecolor: lineSoft, tickcolor: lineSoft, tickfont: { family: mono, size: 10, color: inkFaint } },
      yaxis: { showgrid: true, gridcolor: lineSoft, linecolor: lineSoft, tickcolor: lineSoft, tickfont: { family: mono, size: 10, color: inkFaint }, title: { text: metric.unit, font: { family: mono, size: 10, color: inkFaint } }, rangemode: ['stay_outside_hours', 'pct_daytime_outside', 'sunshine_hours', 'precipitation_sum'].includes(metric.key) ? 'tozero' : undefined },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: 'rgba(20,26,46,0.95)', bordercolor: 'rgba(255,255,255,0.15)', font: { color: ink, family: inter, size: 12 } },
      showlegend: false,
      margin: { l: 48, r: 12, t: 32, b: 32 },
      plot_bgcolor: 'rgba(0,0,0,0)',
      paper_bgcolor: 'rgba(0,0,0,0)',
    };
    window.Plotly.newPlot(ref.current, traces, layout, { responsive: true, displaylogo: false, displayModeBar: false });
  }, [payload, grain, metric.key, focus, overlays, profileId, plotlyReady, allRegions, customResults]);

  return (
    <div className="border border-[#eef0f5] rounded-lg p-2 bg-white">
      <div ref={ref} style={{ width: '100%', height: '220px' }} />
    </div>
  );
}

// ── Leaderboard (all counties, sorted by good-for-outdoors hours) ──

interface LeaderboardProps { payload: Payload; grain: Grain; tag: string; profileId: string; customResults: CustomResults | null; }

function Leaderboard({ payload, grain, tag, profileId, customResults }: LeaderboardProps) {
  const rangeLabel = RANGE_ORDER.find(r => r.tag === tag)?.label ?? tag;

  const rows = useMemo(() => {
    const grainData = payload.grains[grain];
    const all = Object.keys(grainData.regions);
    return all.map((r, idx) => {
      const s = grainData.regions[r];
      const stayY = readSeries(payload, r, 'stay_outside_hours', profileId, grain, customResults);
      const pctY = readSeries(payload, r, 'pct_daytime_outside', profileId, grain, customResults);
      return {
        region: r,
        label: registryLabel(payload, r),
        short: registryShort(payload, r),
        color: registryColor(payload, r, idx),
        ink: registryInk(payload, r),
        stay:      summarize(stayY, 'sum'),
        pct:       summarize(pctY, 'mean'),
        tempMean:  summarize(s.series.temperature_2m_mean ?? [], 'mean'),
        tempMax:   summarize(s.series.temperature_2m_max ?? [], 'max'),
        tempMin:   summarize(s.series.temperature_2m_min ?? [], 'mean'),
        uvMean:    summarize(s.series.uv_index_est_mean ?? [], 'mean'),
        uvMax:     summarize(s.series.uv_index_est_max ?? [], 'max'),
        rain:      summarize(s.series.precipitation_sum ?? [], 'sum'),
        sun:       summarize(s.series.sunshine_hours ?? [], 'sum'),
        cloud:     summarize(s.series.cloud_cover_mean ?? [], 'mean'),
        gust:      summarize(s.series.wind_gusts_10m_max ?? [], 'max'),
      };
    })
    .filter(r => r.stay != null && Number.isFinite(r.stay))
    .sort((a, b) => (b.stay as number) - (a.stay as number));
  }, [payload, grain, profileId, customResults]);

  if (rows.length < 2) return null;

  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div className="mt-6 bg-white border border-[#e3e6ef] rounded-xl shadow-md overflow-hidden">
      <header className="flex items-end justify-between gap-4 flex-wrap px-6 py-4 border-b border-[#e3e6ef] bg-gradient-to-b from-[#fafbff] to-white">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6b7388]">County Leaderboard</div>
          <h3 className="mt-1 text-[22px] font-extrabold tracking-tight text-[#121726]">
            Good-for-outdoors hours — <span className="text-[#4055f1]">{rangeLabel}</span>
          </h3>
        </div>
        <div className="text-sm text-[#6b7388]">
          Ranked best-to-worst across <span className="font-bold text-[#121726] tabular-nums">{rows.length}</span> counties. All metrics are the average across the current time range.
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[15px] tabular-nums">
          <thead>
            <tr className="bg-[#f5f6fb] text-[#39415a]">
              <th className="text-center px-2 py-3 text-xs font-bold uppercase tracking-wider">#</th>
              <th className="text-left px-4 py-3 text-xs font-bold uppercase tracking-wider">County</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider text-[#4055f1]">Good-outdoor hrs</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">% daylight</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">Avg temp</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">Peak temp</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">Avg UV</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">Peak UV</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">Rain (mm)</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">Sunshine hrs</th>
              <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wider">Peak gust</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isTop = i < 3;
              const rankBg = i === 0 ? 'bg-gradient-to-r from-[#fff8d8] to-transparent' : '';
              return (
                <tr
                  key={r.region}
                  className={`leaderboard-row border-t border-[#eef0f5] hover:bg-[#fafbff] transition-colors ${rankBg}`}
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <td className="text-center px-2 py-4 text-[22px] font-bold">
                    {isTop ? <span className="medal">{medals[i]}</span> : <span className="text-[#6b7388] font-extrabold tabular-nums text-[17px]">{i + 1}</span>}
                  </td>
                  <td className="text-left px-4 py-4 whitespace-nowrap">
                    <span className="inline-block w-2.5 h-2.5 rounded-full align-middle mr-2" style={{ background: r.color, boxShadow: `0 0 0 3px ${r.color}22` }} />
                    <span className="font-bold text-[#121726]">{r.label}</span>
                  </td>
                  <td className="text-right px-3 py-4 font-extrabold text-[19px]" style={{ color: r.color }}>
                    {fmtValue(r.stay, 'hrs')}
                  </td>
                  <td className="text-right px-3 py-4 text-[#39415a] font-semibold">{r.pct != null ? `${r.pct.toFixed(0)}%` : '—'}</td>
                  <td className="text-right px-3 py-4 text-[#39415a]">{r.tempMean != null ? `${r.tempMean.toFixed(1)}°C` : '—'}</td>
                  <td className="text-right px-3 py-4 text-[#39415a]">{r.tempMax != null ? `${r.tempMax.toFixed(0)}°C` : '—'}</td>
                  <td className="text-right px-3 py-4 text-[#39415a]">{r.uvMean != null ? r.uvMean.toFixed(1) : '—'}</td>
                  <td className="text-right px-3 py-4 text-[#39415a]">{r.uvMax != null ? r.uvMax.toFixed(1) : '—'}</td>
                  <td className="text-right px-3 py-4 text-[#39415a]">{r.rain != null ? r.rain.toFixed(0) : '—'}</td>
                  <td className="text-right px-3 py-4 text-[#39415a]">{r.sun != null ? r.sun.toFixed(0) : '—'}</td>
                  <td className="text-right px-3 py-4 text-[#39415a]">{r.gust != null ? `${r.gust.toFixed(1)} m/s` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="px-6 py-2.5 text-[12px] text-[#6b7388] border-t border-[#e3e6ef] bg-[#fafbff]">
        Ranking changes with the selected time range. Toggle counties in &ldquo;Compare counties&rdquo; below to show/hide them on the chart.
      </footer>
    </div>
  );
}

// ── Detail panel subcomponent (N-way paired table) ──

interface DetailPanelProps {
  stack: Crumb[];
  onDrillTo: (i: number) => void;
  onClose: () => void;
  onRowDrill: (detailGrain: 'daily' | 'monthly' | 'hourly', rawX: string | number) => void;
  fullscreen: boolean;
  setFullscreen: (f: boolean | ((p: boolean) => boolean)) => void;
  loading: boolean;
  result: DetailResult | null;
  payload: Payload;
  metricLabel: string;
  metricUnit: string;
}

function DetailPanel({ stack, onDrillTo, onClose, onRowDrill, fullscreen, setFullscreen, loading, result, payload, metricLabel, metricUnit }: DetailPanelProps) {
  const current = stack[stack.length - 1];
  const cols = result ? DETAIL_COLS[result.detailGrain] : [];
  const shared = cols.filter(c => !c.paired);
  const leading = cols.filter(c => c.paired && c.leading);
  const trailing = cols.filter(c => c.paired && !c.leading);
  const ordered = [...shared, ...leading, ...trailing];
  const regions = result?.regions || [];

  // Pull the LLM writer's take if this month is in the summaries bundle.
  const writerTake = (() => {
    if (!payload.summaries?.monthly) return null;
    // We want the summary for the month we're viewing — that's the crumb with grain==='monthly'.
    // If the current level is "monthly" (user picked a year, looking at months): no per-bucket summary yet.
    // If the current level is "daily" (user picked a month, looking at days): show the summary for that month.
    // If "hourly-drill": show the summary for the parent month.
    let monthKey: string | null = null;
    if (current.grain === 'daily' || current.grain === 'monthly') {
      monthKey = String(current.bucket).slice(0, 7);
    } else if (current.grain === 'hourly-drill') {
      monthKey = String(current.bucket).slice(0, 7);
    }
    return monthKey ? payload.summaries.monthly[monthKey] ?? null : null;
  })();

  const containerCls = `bg-white border border-[#e3e6ef] rounded-xl shadow-md overflow-hidden flex flex-col mt-5 ${
    fullscreen ? 'fixed inset-0 z-[1000] m-0 rounded-none border-0' : 'max-w-[1320px] mx-auto'
  }`;

  const drillable = result && (result.detailGrain === 'daily' || result.detailGrain === 'monthly');

  return (
    <section className={containerCls}>
      <div className="flex justify-between items-center gap-3 px-6 py-3 bg-gradient-to-b from-[#fafbff] to-[#f5f6fb] border-b border-[#e3e6ef]">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-bold text-lg text-[#121726]">{current.xLabel} — {regions.length} counties side-by-side</span>
          <span className="text-sm text-[#6b7388]">Drill by {metricLabel.toLowerCase()} · {metricUnit} where applicable</span>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button className="text-sm font-semibold px-4 py-2 border border-[#e3e6ef] rounded-lg bg-white text-[#39415a] hover:bg-[#f4f5fa] hover:border-[#c9cedb]" onClick={() => setFullscreen(f => !f)}>
            {fullscreen ? '⤡ Exit full screen' : '⤢ Full screen'}
          </button>
          <button className="text-sm font-semibold px-4 py-2 border border-[#e3e6ef] rounded-lg bg-white text-[#39415a] hover:bg-[#f4f5fa] hover:border-[#c9cedb]" onClick={onClose}>×</button>
        </div>
      </div>

      <div className={`p-5 overflow-auto ${fullscreen ? 'flex-1' : 'max-h-[640px]'}`}>
        <nav className="flex items-center gap-1.5 flex-wrap mb-3 px-3 py-1.5 bg-[#fafbff] border border-[#e8ebf3] rounded-md text-sm">
          {stack.map((c, i) => {
            const last = i === stack.length - 1;
            return (
              <span key={i} className="inline-flex items-center">
                {last ? (
                  <span className="px-2 py-1 rounded text-[#121726] font-bold">{c.xLabel} <span className="text-xs text-[#6b7388] font-medium"> · {c.grain === 'hourly-drill' ? 'hourly' : c.grain}</span></span>
                ) : (
                  <button onClick={() => onDrillTo(i)} className="px-2 py-1 rounded text-[#4055f1] font-semibold hover:bg-[#4055f1]/10 hover:underline">
                    {c.xLabel} <span className="text-xs text-[#6b7388] font-medium"> · {c.grain === 'hourly-drill' ? 'hourly' : c.grain}</span>
                  </button>
                )}
                {!last && <span className="text-[#6b7388] px-0.5">›</span>}
              </span>
            );
          })}
        </nav>

        {loading ? (
          <p className="text-[#6b7388] text-[15px]">Loading…</p>
        ) : !result || !result.rows.length ? (
          <p className="text-[#6b7388] text-[15px]">No underlying rows for this point.</p>
        ) : (
          <>
            {writerTake && (
              <div className="mb-3 p-3.5 bg-gradient-to-br from-[#fffbea] to-[#fff4d0] border border-[#f0dd95] border-l-4 border-l-[#d97706] rounded text-[15px] leading-relaxed text-[#3c2f0a]">
                <span className="inline-block mr-2 px-2.5 py-0.5 rounded-full bg-[#d97706] text-white text-[10px] font-bold uppercase tracking-widest align-middle">Writer&rsquo;s take</span>
                {writerTake}
              </div>
            )}
            <div className="mb-3 p-3 px-3.5 bg-[#f0f4ff] border-l-4 border-[#4055f1] rounded text-[13.5px] leading-relaxed text-[#39415a]">
              {result.detailGrain === 'hourly' ? (
                <><strong>Hourly view: {result.rows.length} rows.</strong> <strong>Stay-out</strong> = how many of 3 sample neighborhoods passed <em>all four</em> rules that hour. Driver columns to the right show <em>why</em>.</>
              ) : (
                <><strong>{result.rows.length} {result.detailGrain} rows, {regions.length} counties.</strong> Classification columns lead; winner starred per row.{drillable && <><strong> Click a row</strong> to drop into the {result.detailGrain === 'daily' ? 'hour-by-hour' : 'day-by-day'} view.</>}</>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="border-collapse w-full text-[15px] tabular-nums">
                <thead>
                  <tr>
                    {ordered.map(c => {
                      if (!c.paired) return <th key={c.key} rowSpan={2} className="sticky top-0 z-20 bg-[#f5f6fb] text-[#39415a] px-3 py-3 border-b border-[#e3e6ef] text-left font-bold text-xs uppercase tracking-wider whitespace-nowrap border-r-2 border-r-[#dde2ef]">{c.label}</th>;
                      return <th key={c.key} colSpan={regions.length} className={`sticky top-0 z-10 px-3 py-2.5 text-center border-b border-[#e3e6ef] text-xs uppercase tracking-wider whitespace-nowrap ${c.leading ? 'bg-gradient-to-b from-[#eef5ff] to-[#dfe9ff] text-[#4055f1] font-extrabold' : 'bg-[#eef1f8] text-[#39415a] font-bold'} border-r border-r-[#dde2ef]`}>{c.label}</th>;
                    })}
                  </tr>
                  <tr>
                    {ordered.map(c => {
                      if (!c.paired) return null;
                      return regions.map((r, idx) => {
                        const color = registryColor(payload, r, idx);
                        return (
                          <th key={`${c.key}-${r}`} className={`sticky bg-[#f9fafd] px-3 py-1.5 text-[12px] text-[#6b7388] font-semibold border-b border-[#e3e6ef] text-left whitespace-nowrap ${c.leading ? 'font-bold text-[#121726]' : ''}`} style={{ top: '41px' }}>
                            <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: color }} />{registryShort(payload, r)}
                          </th>
                        );
                      });
                    })}
                  </tr>
                </thead>
                <tbody className={drillable ? 'cursor-pointer' : ''}>
                  {result.rows.map((row, i) => {
                    const winners: Record<string, RegionKey | null> = {};
                    leading.forEach(c => { winners[c.key] = leadingWinner(row, c.key, regions); });
                    return (
                      <tr key={i}
                          className={drillable ? 'hover:bg-[#eef4ff] transition-colors' : 'hover:bg-[#fafbff]'}
                          onClick={drillable ? () => onRowDrill(result.detailGrain as 'daily' | 'monthly', row._x) : undefined}>
                        {ordered.map(c => {
                          if (!c.paired) {
                            const val = c.key === 'x' ? row._x : (row as any)[c.key] ?? row._x;
                            const display = c.key === 'x' ? prettyBucket(val, result.detailGrain as Grain) : fmtCell(val as any, c.fmt);
                            return <td key={c.key} className="px-3 py-2.5 border-b border-[#eef0f5] whitespace-nowrap font-semibold text-[#121726] bg-[#fafbff] border-r-2 border-r-[#e3e6ef]">
                              {drillable && <span className="text-[#6b7388] font-bold mr-1.5">›</span>}{display}
                            </td>;
                          }
                          return regions.map((r, idx) => {
                            const val = (row[r] as Record<string, number | null> | undefined)?.[c.key];
                            const isWinner = c.leading && winners[c.key] === r;
                            const tdCls = `px-3 py-2.5 border-b border-[#eef0f5] whitespace-nowrap ${c.fmt === 'bool' || c.fmt === 'pts' ? 'text-center' : 'text-right'} ${
                              c.leading ? (isWinner ? 'bg-gradient-to-r from-[#4055f1]/15 to-[#4055f1]/5 font-bold text-[#121726]' : 'bg-[#4055f1]/5 font-semibold') : 'text-[#39415a]'
                            } ${idx < regions.length - 1 ? 'border-r border-dashed border-[#e8ebf3]' : 'border-r border-[#dde2ef]'}`;
                            return <td key={`${c.key}-${r}`} className={tdCls}>{fmtCell(val, c.fmt)}{isWinner && <span className="ml-1.5 text-[#4055f1] text-[11px] align-[2px]">★</span>}</td>;
                          });
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
