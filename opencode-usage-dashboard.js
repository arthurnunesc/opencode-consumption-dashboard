#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";

const DB_PATH = process.env.OPENCODE_DB ?? `${process.env.HOME}/.local/share/opencode/opencode.db`;
const MODELS_JSON = process.env.MODELS_JSON ?? `${process.env.HOME}/.cache/opencode/models.json`;
const PORT = Number(process.env.PORT ?? 8765);

const COMMANDCODE_PRICING = {
  "deepseek-v4-pro":             { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  "deepseek-v4-flash":           { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "kimi-k2.6":                   { input: 0.95, output: 4.00, cacheRead: 0.16 },
  "kimi-k2.5":                   { input: 0.60, output: 3.00, cacheRead: 0.10 },
  "glm-5.1":                     { input: 1.40, output: 4.40, cacheRead: 0.26 },
  "glm-5":                       { input: 1.00, output: 3.20, cacheRead: 0.20 },
  "minimax-m3":                  { input: 0.30, output: 1.20, cacheRead: 0.06 },
  "minimax-m2.7":                { input: 0.30, output: 1.20, cacheRead: 0.06 },
  "minimax-m2.5":                { input: 0.30, output: 1.20, cacheRead: 0.03 },
  "qwen-3.6-max-preview":       { input: 1.30, output: 7.80, cacheRead: 0.26, cacheWrite: 1.63 },
  "qwen-3.6-plus":              { input: 0.50, output: 3.00, cacheRead: 0.10 },
  "qwen-3.7-max":               { input: 2.50, output: 7.50, cacheRead: 0.50, cacheWrite: 3.13 },
  "qwen-3.7-plus":              { input: 0.40, output: 1.60, cacheRead: 0.08, cacheWrite: 0.50 },
  "step-3.7-flash":             { input: 0.20, output: 1.15, cacheRead: 0.04 },
  "step-3.5-flash":             { input: 0.10, output: 0.30, cacheRead: 0.02 },
  "mimo-v2.5-pro":              { input: 0.435, output: 0.87, cacheRead: 0.0036 },
  "mimo-v2.5":                  { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "nemotron-3-ultra":           { input: 0.37, output: 1.08, cacheRead: 0.14 },
  "claude-fable-5":             { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.50 },
  "claude-opus-4.8":            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  "claude-opus-4.7":            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  "claude-opus-4.6":            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  "claude-sonnet-4.6":          { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-sonnet-4.5":          { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-haiku-4.5":           { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
  "gpt-5.5":                    { input: 5, output: 30, cacheRead: 0.50 },
  "gpt-5.5-fast":               { input: 12.50, output: 75, cacheRead: 1.25 },
  "gpt-5.4":                    { input: 2.50, output: 15, cacheRead: 0.25 },
  "gpt-5.4-mini":               { input: 0.75, output: 4.50, cacheRead: 0.075 },
  "gpt-5.3-codex":              { input: 2, output: 8, cacheRead: 0.50 },
  "gemini-3.5-flash":           { input: 1.50, output: 9, cacheRead: 0.15 },
  "gemini-3.1-flash-lite":      { input: 0.25, output: 1.50, cacheRead: 0.03 },
};

function monthKey(timestamp) {
  const date = new Date(Number(timestamp));
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
}

function dayKey(timestamp) {
  const date = new Date(Number(timestamp));
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0");
}

function normalizeModelId(provider, model) {
  let id = String(model).toLowerCase();
  if (provider === "commandcode") {
    id = id.replace(/^.*\//, "");
    id = id.replace(/^qwen(\d)/, "qwen-$1");
  }
  return id;
}

function loadModelsJsonPricing() {
  try {
    const raw = readFileSync(MODELS_JSON, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("Invalid JSON");

    const map = new Map();

    for (const providerKey of ["openai", "google", "opencode", "opencode-go"]) {
      const provider = data[providerKey];
      if (!provider || !provider.models) continue;
      for (const [modelId, modelData] of Object.entries(provider.models)) {
        if (!modelData.cost) continue;
        const key = modelId.toLowerCase();
        if (map.has(key)) continue;
        map.set(key, {
          input: Number(modelData.cost.input ?? 0),
          output: Number(modelData.cost.output ?? 0),
          cacheRead: Number(modelData.cost.cache_read ?? 0),
          cacheWrite: Number(modelData.cost.cache_write ?? 0),
        });
      }
    }

    return map;
  } catch (_e) {
    return null;
  }
}

const MODELS_JSON_PRICING = loadModelsJsonPricing();

export { DB_PATH, MODELS_JSON, COMMANDCODE_PRICING, MODELS_JSON_PRICING, normalizeModelId, loadModelsJsonPricing, calculateCostFromPricing, calculateMessageCost, aggregateUsage, monthKey, dayKey }; 

function calculateCostFromPricing(pricing, tokens) {
  return (
    (tokens.input * pricing.input +
      tokens.output * pricing.output +
      tokens.reasoning * pricing.output +
      tokens.cacheRead * (pricing.cacheRead ?? 0) +
      tokens.cacheWrite * (pricing.cacheWrite ?? 0)) /
    1_000_000
  );
}

function calculateMessageCost(provider, model, tokens, recordedCost) {
  if (recordedCost > 0) {
    return { cost: recordedCost, source: "Recorded by OpenCode" };
  }

  const modelKey = normalizeModelId(provider, model);

  const ccPrice = COMMANDCODE_PRICING[modelKey];
  if (ccPrice) {
    return { cost: calculateCostFromPricing(ccPrice, tokens), source: "CommandCode pricing" };
  }

  if (MODELS_JSON_PRICING) {
    const price = MODELS_JSON_PRICING.get(modelKey);
    if (price) {
      return { cost: calculateCostFromPricing(price, tokens), source: "Provider pricing (models.json)" };
    }
  }

  return { cost: 0, source: "Unavailable" };
}

function aggregateUsage() {
  const db = new Database(DB_PATH, { readonly: true });
  const maxRow = db.query("select max(rowid) as max from message").get()?.max ?? 0;
  const usage = new Map();
  const dailyData = new Map();
  const modelTotals = new Map();
  let latestTimestamp = 0;
  let earliestTimestamp = Infinity;

  for (let start = 1; start <= maxRow; start += 500) {
    const end = start + 499;
    const rows = db
      .query("select time_created, data from message where rowid between " + start + " and " + end)
      .all();

    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }

      if (data.role !== "assistant" || !data.modelID || !data.tokens) continue;

      const inputTokens = Number(data.tokens.input ?? 0);
      const outputTokens = Number(data.tokens.output ?? 0);
      const reasoningTokens = Number(data.tokens.reasoning ?? 0);
      const cacheReadTokens = Number(data.tokens.cache?.read ?? 0);
      const cacheWriteTokens = Number(data.tokens.cache?.write ?? 0);
      const recordedCost = Number(data.cost ?? 0);
      const totalTokens = inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;

      if (totalTokens <= 0) continue;

      const timestamp = Number(row.time_created);
      if (timestamp > latestTimestamp) latestTimestamp = timestamp;
      if (timestamp < earliestTimestamp) earliestTimestamp = timestamp;

      const provider = data.providerID ?? "unknown";
      const model = data.modelID ?? "unknown";

      const pricing = calculateMessageCost(
        provider,
        model,
        { input: inputTokens, output: outputTokens, reasoning: reasoningTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens },
        recordedCost,
      );

      const month = monthKey(timestamp);
      const key = month + "\t" + provider + "\t" + model;
      const current = usage.get(key) ?? {
        month,
        provider,
        model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        calculatedCost: 0,
        priceSources: new Set(),
      };

      current.calls += 1;
      current.inputTokens += inputTokens;
      current.outputTokens += outputTokens;
      current.reasoningTokens += reasoningTokens;
      current.cacheReadTokens += cacheReadTokens;
      current.cacheWriteTokens += cacheWriteTokens;
      current.cost += recordedCost;
      current.calculatedCost += pricing.cost;
      current.priceSources.add(pricing.source);
      usage.set(key, current);

      const date = dayKey(timestamp);
      const existing = dailyData.get(date) ?? { tokens: 0, cost: 0 };
      existing.tokens += totalTokens;
      existing.cost += pricing.cost;
      dailyData.set(date, existing);

      const modelKey = provider + "/" + model;
      const mt = modelTotals.get(modelKey) ?? { tokens: 0, calls: 0, cost: 0 };
      mt.tokens += totalTokens;
      mt.calls += 1;
      mt.cost += pricing.cost;
      modelTotals.set(modelKey, mt);
    }
  }

  const rows = [...usage.values()].sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );

  for (const row of rows) {
    row.priceSource = [...row.priceSources].join(", ");
    delete row.priceSources;
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.calls += row.calls;
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.reasoningTokens += row.reasoningTokens;
      acc.cacheReadTokens += row.cacheReadTokens;
      acc.cacheWriteTokens += row.cacheWriteTokens;
      acc.cost += row.cost;
      acc.calculatedCost += row.calculatedCost;
      return acc;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, calculatedCost: 0 },
  );

  let thirtyDay = null;
  let dailyBreakdown = [];
  let modelRanking = [];

  if (latestTimestamp > 0) {
    const latestDate = new Date(latestTimestamp);
    latestDate.setUTCHours(0, 0, 0, 0);
    const cutoff = latestDate.getTime() - 30 * 24 * 60 * 60 * 1000;

    const thirtyDayEntries = [...dailyData.entries()]
      .filter(function ([date]) {
        const parts = date.split("-");
        const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
        return d.getTime() >= cutoff;
      });

    const tdTokens = thirtyDayEntries.reduce(function (s, e) { return s + e[1].tokens; }, 0);
    const tdCost = thirtyDayEntries.reduce(function (s, e) { return s + e[1].cost; }, 0);
    const activeDays = thirtyDayEntries.length || 1;

    let busiestDay = { date: "-", tokens: 0 };
    for (const [d, v] of thirtyDayEntries) {
      if (v.tokens > busiestDay.tokens) busiestDay = { date: d, tokens: v.tokens };
    }

    const lifetimeMs = latestTimestamp - earliestTimestamp;
    const lifetimeDays = Math.max(1, Math.ceil(lifetimeMs / 86400000));
    const allTimeTokens = totals.inputTokens + totals.outputTokens + totals.reasoningTokens + totals.cacheReadTokens + totals.cacheWriteTokens;

    thirtyDay = {
      totalTokens: tdTokens,
      totalCost: tdCost,
      avgDailyTokens: Math.round(tdTokens / activeDays),
      avgDailyCost: tdCost / activeDays,
      costPerMillionTokens: tdTokens > 0 ? (tdCost / tdTokens) * 1_000_000 : 0,
      busiestDay: busiestDay.date,
      busiestDayTokens: busiestDay.tokens,
      activeDays: activeDays,
      lifetimeTypical30dCost: (totals.calculatedCost / lifetimeDays) * 30,
      lifetimeTypical30dTokens: Math.round((allTimeTokens / lifetimeDays) * 30),
      lifetimeDays: lifetimeDays,
    };

    dailyBreakdown = thirtyDayEntries
      .sort(function (a, b) { return a[0].localeCompare(b[0]); })
      .map(function (e) { return { date: e[0], tokens: e[1].tokens, cost: e[1].cost }; });

    modelRanking = [...modelTotals.entries()]
      .sort(function (a, b) { return b[1].tokens - a[1].tokens; })
      .slice(0, 3)
      .map(function (e) { return { model: e[0], tokens: e[1].tokens, calls: e[1].calls, cost: e[1].cost }; });
  }

  return {
    generatedAt: new Date().toISOString(),
    source: DB_PATH,
    months: [...new Set(rows.map(function (row) { return row.month; }))],
    models: [...new Set(rows.map(function (row) { return row.provider + "/" + row.model; }))],
    totals: totals,
    rows: rows,
    dailyBreakdown: dailyBreakdown,
    thirtyDay: thirtyDay,
    modelRanking: modelRanking,
  };
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCode Token Consumption</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: #18181b;
      --panel-hover: #1f1f23;
      --text: #fafafa;
      --muted: #a1a1aa;
      --muted-2: #71717a;
      --border: rgba(255, 255, 255, 0.06);
      --border-strong: rgba(255, 255, 255, 0.10);
      --grid: rgba(255, 255, 255, 0.04);
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 400 16px/1.55 var(--font);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      z-index: 9999;
      pointer-events: none;
      opacity: 0.025;
      background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-repeat: repeat;
      background-size: 256px 256px;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 48px 28px 64px; }
    header { margin-bottom: 36px; }
    h1 {
      margin: 0;
      font: 500 clamp(32px, 5vw, 54px)/0.95 var(--font);
      letter-spacing: -0.04em;
    }
    .subtitle {
      margin-top: 12px;
      color: var(--muted);
      max-width: 680px;
      font-size: 16px;
      line-height: 1.6;
    }
    .pill {
      display: inline-block;
      margin-top: 16px;
      padding: 7px 14px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted-2);
      font-size: 13px;
      font-weight: 400;
    }

    .cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 32px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 24px 26px;
      transition: transform 150ms cubic-bezier(0.16, 1, 0.3, 1), border-color 150ms ease;
    }
    .card:active { transform: scale(0.99); }
    .card-label {
      color: var(--muted-2);
      font-size: 12px;
      font-weight: 400;
      text-transform: uppercase;
      letter-spacing: 0.10em;
      margin-bottom: 8px;
    }
    .card-value {
      font: 500 clamp(22px, 2.8vw, 34px)/1.15 var(--font);
      letter-spacing: -0.03em;
      cursor: help;
    }
    .card-context {
      margin-top: 6px;
      color: var(--muted-2);
      font-size: 13px;
      font-weight: 400;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 26px 28px;
      margin-bottom: 20px;
    }
    .panel-label {
      color: var(--muted);
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 18px;
      letter-spacing: -0.01em;
    }

    .chart-wrap { overflow-x: auto; padding-bottom: 6px; }
    .chart {
      min-width: 920px;
      height: 440px;
      display: grid;
      grid-template-columns: 64px 1fr;
      grid-template-rows: 1fr 40px;
      gap: 0 14px;
    }
    .axis {
      grid-row: 1;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      color: var(--muted-2);
      font-size: 12px;
      text-align: right;
      padding-right: 6px;
    }
    .plot {
      position: relative;
      grid-column: 2;
      grid-row: 1;
      border-left: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: end;
      gap: 32px;
      padding: 0 24px;
    }
    .plot::before {
      content: "";
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(to top, var(--grid), var(--grid) 1px, transparent 1px, transparent 20%);
      pointer-events: none;
    }
    .bar-group {
      position: relative;
      z-index: 1;
      flex: 1;
      min-width: 90px;
      height: 100%;
      display: flex;
      align-items: end;
      justify-content: center;
    }
    .bar {
      width: min(76px, 68%);
      min-height: 1px;
      border-radius: 8px 8px 0 0;
      overflow: hidden;
      background: var(--panel);
      display: flex;
      flex-direction: column-reverse;
      transition: filter 200ms ease, transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .bar-group:hover .bar {
      filter: brightness(1.12);
      transform: translateY(-2px);
    }
    .segment {
      width: 100%;
      min-height: 1px;
      transition: filter 120ms ease;
    }
    .segment:hover { filter: brightness(1.15) saturate(1.1); }
    .x-axis {
      grid-column: 2;
      grid-row: 2;
      display: flex;
      gap: 32px;
      padding: 10px 24px 0;
      color: var(--muted-2);
    }
    .x-axis div { flex: 1; min-width: 90px; text-align: center; font-size: 12px; }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-top: 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .legend span { display: inline-flex; align-items: center; gap: 7px; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

    .table-wrap { overflow: auto; max-height: 560px; }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td { padding: 12px 10px; border-bottom: 1px solid var(--border); text-align: right; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
    th {
      color: var(--muted-2);
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      position: sticky;
      top: 0;
      background: var(--panel);
      cursor: pointer;
      user-select: none;
    }
    th::after {
      content: "";
      display: inline-block;
      width: 0;
      height: 0;
      margin-left: 4px;
      vertical-align: middle;
      opacity: 0;
      transition: opacity 150ms ease;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-bottom: 5px solid transparent;
    }
    th:hover::after { opacity: 0.35; }
    th.sort-asc::after {
      opacity: 1;
      border-bottom-color: var(--muted);
    }
    th.sort-desc::after {
      opacity: 1;
      border-bottom-color: var(--muted);
      transform: rotate(180deg);
    }
    td { font-size: 14px; color: var(--muted); font-variant-numeric: tabular-nums; }

    .error-panel {
      border-color: rgba(239, 68, 68, 0.18);
      background: linear-gradient(180deg, rgba(239, 68, 68, 0.04), transparent), var(--panel);
      color: #fca5a5;
      padding: 20px 24px;
      border-radius: 20px;
    }
    .error-panel .error-title { color: #f87171; font-weight: 500; margin-bottom: 4px; }

    .skeleton {
      background: linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.03) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 6px;
    }
    .skeleton-label { height: 12px; width: 84px; margin-bottom: 12px; }
    .skeleton-value { height: 30px; width: 150px; }
    .skeleton-chart { height: 440px; width: 100%; border-radius: 12px; }
    .skeleton-row { height: 40px; width: 100%; border-radius: 6px; margin-bottom: 6px; }

    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    @media (max-width: 760px) {
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .card { padding: 18px 20px; }
      .card-value { font-size: clamp(18px, 5vw, 26px); }
      main { padding: 32px 16px 44px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>OpenCode Token Consumption</h1>
      <div class="subtitle">Token usage and cost estimation across all providers. Monthly breakdown grouped by model, plus 30-day rolling averages.</div>
      <div class="pill" id="generated">Loading...</div>
    </header>

    <section class="cards" id="cards">
      <div class="card"><div class="skeleton skeleton-label"></div><div class="skeleton skeleton-value"></div></div>
      <div class="card"><div class="skeleton skeleton-label"></div><div class="skeleton skeleton-value"></div></div>
      <div class="card"><div class="skeleton skeleton-label"></div><div class="skeleton skeleton-value"></div></div>
      <div class="card"><div class="skeleton skeleton-label"></div><div class="skeleton skeleton-value"></div></div>
      <div class="card"><div class="skeleton skeleton-label"></div><div class="skeleton skeleton-value"></div></div>
      <div class="card"><div class="skeleton skeleton-label"></div><div class="skeleton skeleton-value"></div></div>
    </section>

    <div class="panel" id="chartPanel">
      <div class="panel-label">Monthly Breakdown</div>
      <div class="skeleton skeleton-chart"></div>
    </div>

    <div class="panel" id="tablePanel">
      <div class="panel-label">Details</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-key="month" data-type="text">Month</th>
              <th data-key="modelLabel" data-type="text">Model</th>
              <th data-key="calls" data-type="number">Calls</th>
              <th data-key="inputTokens" data-type="number">Input</th>
              <th data-key="outputTokens" data-type="number">Output</th>
              <th data-key="reasoningTokens" data-type="number">Reasoning</th>
              <th data-key="cacheReadTokens" data-type="number">Cache Rd</th>
              <th data-key="cacheWriteTokens" data-type="number">Cache Wr</th>
              <th data-key="totalTokens" data-type="number">Total</th>
              <th data-key="calculatedCost" data-type="number">Price</th>
              <th data-key="priceSource" data-type="text">Source</th>
            </tr>
          </thead>
          <tbody id="rows">
            <tr><td colspan="11" style="text-align:center;padding:32px;color:var(--muted-2)">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </main>
  <script>
    var colors = ["#a5d8ff","#ffc9de","#b2f2bb","#ffd8a8","#d0bfff","#96f2d7","#99e9f2","#fcc2d7","#b2ddff","#ffb3ba","#d4f0c0","#ffe0b2"];
    var fmt = new Intl.NumberFormat();
    var money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
    function tokenTotal(row) { return row.inputTokens + row.outputTokens + row.reasoningTokens + row.cacheReadTokens + row.cacheWriteTokens; }
    var tableRows = [];
    var sortState = { key: "month", direction: "asc", type: "text" };

    function formatShort(n) {
      var abs = Math.abs(n);
      if (abs >= 1e9) {
        var b = Math.round(n / 1e7) / 100;
        return b.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " billion";
      }
      if (abs >= 1e6) {
        var m = Math.round(n / 1e6);
        return new Intl.NumberFormat().format(m) + " million";
      }
      return new Intl.NumberFormat().format(Math.round(n));
    }

    function formatShortMoney(n) {
      var abs = Math.abs(n);
      if (abs >= 1e9) {
        var b = Math.round(n / 1e7) / 100;
        return "US$ " + b.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " billion";
      }
      if (abs >= 1e6) {
        var m = Math.round(n / 1e6);
        return "US$ " + new Intl.NumberFormat().format(m) + " million";
      }
      return "US$ " + new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    }

    function cardMarkup(label, value, context, tooltip) {
      context = context || "";
      var title = tooltip ? " title=\"" + tooltip.replace(/"/g, "&quot;") + "\"" : "";
      return "<div class=\"card\"><div class=\"card-label\">" + label + "</div><div class=\"card-value\"" + title + ">" + value + "</div>" + (context ? "<div class=\"card-context\">" + context + "</div>" : "") + "</div>";
    }

    function render(data) {
      var modelColors = {};
      data.models.forEach(function(model, i) { modelColors[model] = colors[i % colors.length]; });
      var monthTotals = {};
      data.months.forEach(function(month) { monthTotals[month] = data.rows.filter(function(r) { return r.month === month; }).reduce(function(s, r) { return s + tokenTotal(r); }, 0); });
      var max = Math.max.apply(null, Object.values(monthTotals).concat([1]));
      var grandTotal = tokenTotal(data.totals);

      document.getElementById("generated").textContent = "Generated " + new Date(data.generatedAt).toLocaleString();

      var cardHtml = "";

      if (data.thirtyDay) {
        var td = data.thirtyDay;
        cardHtml += cardMarkup("All-Time Cost", formatShortMoney(data.totals.calculatedCost), "Across all sessions", money.format(data.totals.calculatedCost));
        cardHtml += cardMarkup("Typical 30d Cost", formatShortMoney(td.lifetimeTypical30dCost), "Projected from " + td.lifetimeDays + "d lifetime avg", money.format(td.lifetimeTypical30dCost));
        cardHtml += cardMarkup("30d Avg Cost/Day", formatShortMoney(td.avgDailyCost), "Last 30 days, " + td.activeDays + " active days", money.format(td.avgDailyCost));

        cardHtml += cardMarkup("All-Time Tokens", formatShort(grandTotal), data.months.length + " months, " + data.rows.length + " model-entries", fmt.format(grandTotal));
        cardHtml += cardMarkup("Typical 30d Tokens", formatShort(td.lifetimeTypical30dTokens), "Projected from " + td.lifetimeDays + "d lifetime avg", fmt.format(td.lifetimeTypical30dTokens));
        cardHtml += cardMarkup("30d Avg Tokens/Day", formatShort(td.avgDailyTokens), "Last 30 days, " + td.activeDays + " active days", fmt.format(td.avgDailyTokens));
      } else {
        cardHtml += cardMarkup("All-Time Cost", "-", "No data");
        cardHtml += cardMarkup("Typical 30d Cost", "-", "No data");
        cardHtml += cardMarkup("30d Avg Cost/Day", "-", "No data");
        cardHtml += cardMarkup("All-Time Tokens", "-", "No data");
        cardHtml += cardMarkup("Typical 30d Tokens", "-", "No data");
        cardHtml += cardMarkup("30d Avg Tokens/Day", "-", "No data");
      }

      document.getElementById("cards").innerHTML = cardHtml;

      var marks = [1, 0.75, 0.5, 0.25, 0].map(function(v) {
        return "<div>" + fmt.format(Math.round(max * v)) + "</div>";
      }).join("");

      var bars = data.months.map(function(month) {
        var height = monthTotals[month] / max * 100;
        var segments = data.rows.filter(function(r) { return r.month === month; }).map(function(row) {
          var model = row.provider + "/" + row.model;
          var segH = tokenTotal(row) / monthTotals[month] * 100;
          var title = month + "  " + model + "\nTotal: " + fmt.format(tokenTotal(row)) + "  Input: " + fmt.format(row.inputTokens) + "  Output: " + fmt.format(row.outputTokens) + "\nCost: " + money.format(row.calculatedCost) + "  Source: " + row.priceSource;
          return "<div class=\"segment\" title=\"" + title + "\" style=\"height:" + segH + "%;background:" + modelColors[model] + "\"></div>";
        }).join("");
        return "<div class=\"bar-group\"><div class=\"bar\" style=\"height:" + height + "%\">" + segments + "</div></div>";
      }).join("");

      var labels = data.months.map(function(month) { return "<div>" + month + "</div>"; }).join("");
      var legend = data.models.map(function(m) { return "<span><i class=\"swatch\" style=\"background:" + modelColors[m] + "\"></i>" + m + "</span>"; }).join("");

      document.getElementById("chartPanel").innerHTML = "<div class=\"panel-label\">Monthly Breakdown</div><div class=\"chart-wrap\"><div class=\"chart\"><div class=\"axis\">" + marks + "</div><div class=\"plot\">" + bars + "</div><div class=\"x-axis\">" + labels + "</div></div></div><div class=\"legend\">" + legend + "</div>";

      tableRows = data.rows.map(function(row) {
        var r = Object.assign({}, row);
        r.modelLabel = row.provider + "/" + row.model;
        r.totalTokens = tokenTotal(row);
        return r;
      });

      document.querySelectorAll("th[data-key]").forEach(function(th) {
        th.addEventListener("click", function() {
          var key = th.dataset.key;
          var type = th.dataset.type;
          sortState = {
            key: key,
            type: type,
            direction: sortState.key === key && sortState.direction === "desc" ? "asc" : "desc",
          };
          renderRows();
        });
      });

      renderRows();
    }

    function renderRows() {
      var rows = tableRows.slice().sort(function(a, b) {
        var av = a[sortState.key], bv = b[sortState.key];
        var r = sortState.type === "number" ? (Number(av ?? 0) - Number(bv ?? 0)) : String(av ?? "").localeCompare(String(bv ?? ""));
        return sortState.direction === "asc" ? r : -r;
      });

      document.querySelectorAll("th[data-key]").forEach(function(th) {
        th.classList.remove("sort-asc", "sort-desc");
      });
      var activeTh = document.querySelector("th[data-key=\"" + sortState.key + "\"]");
      if (activeTh) activeTh.classList.add(sortState.direction === "asc" ? "sort-asc" : "sort-desc");

      document.getElementById("rows").innerHTML = rows.map(function(row) {
        return "<tr><td>" + row.month + "</td><td>" + (row.provider + "/" + row.model) + "</td><td>" + fmt.format(row.calls) + "</td><td>" + fmt.format(row.inputTokens) + "</td><td>" + fmt.format(row.outputTokens) + "</td><td>" + fmt.format(row.reasoningTokens) + "</td><td>" + fmt.format(row.cacheReadTokens) + "</td><td>" + fmt.format(row.cacheWriteTokens) + "</td><td>" + fmt.format(row.totalTokens) + "</td><td>" + money.format(row.calculatedCost) + "</td><td>" + row.priceSource + "</td></tr>";
      }).join("");
    }

    fetch("/api/usage")
      .then(function(response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(render)
      .catch(function(error) {
        var errHtml = "<section class=\"error-panel\"><div class=\"error-title\">Could not load usage data</div>" + error.message + "</section>";
        document.getElementById("cards").insertAdjacentHTML("afterend", errHtml);
      });
  </script>
</body>
</html>`;

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/usage") {
        try {
          return Response.json(aggregateUsage());
        } catch (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }
      }

      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  console.log("OpenCode usage dashboard: http://localhost:" + PORT);
  console.log("database: " + DB_PATH);
}
