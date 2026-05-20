#!/usr/bin/env bun

import { Database } from "bun:sqlite";

const DB_PATH = process.env.OPENCODE_DB ?? `${process.env.HOME}/.local/share/opencode/opencode.db`;
const PORT = Number(process.env.PORT ?? 8765);
const OPENAI_PRICING_PER_MILLION = {
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
};
const MINIMAX_CNY_PER_USD = Number(process.env.MINIMAX_CNY_PER_USD ?? 7.1);
const MINIMAX_PRICING_PER_MILLION_CNY = {
  "minimax-m2.7": { input: 2.1, output: 8.4, cacheRead: 0.42, cacheWrite: 2.625 },
  "minimax-m2.7-highspeed": { input: 4.2, output: 16.8, cacheRead: 0.42, cacheWrite: 2.625 },
  "minimax-m2.5": { input: 2.1, output: 8.4, cacheRead: 0.21, cacheWrite: 2.625 },
  "minimax-m2.5-highspeed": { input: 4.2, output: 16.8, cacheRead: 0.21, cacheWrite: 2.625 },
};
const GEMINI_PRICING_PER_MILLION = {
  "gemini-3.1-pro-preview": {
    short: { input: 2, cachedInput: 0.2, output: 12 },
    long: { input: 4, cachedInput: 0.4, output: 18 },
    threshold: 200_000,
  },
};

function monthKey(timestamp) {
  const date = new Date(Number(timestamp));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function normalizedModel(model) {
  return String(model).toLowerCase();
}

function calculateMessageCost(provider, model, tokens, recordedCost) {
  const modelKey = normalizedModel(model);
  const openai = provider === "openai" ? OPENAI_PRICING_PER_MILLION[modelKey] : undefined;

  if (openai) {
    return {
      cost:
        ((tokens.input + tokens.cacheWrite) * openai.input +
          tokens.cacheRead * openai.cachedInput +
          (tokens.output + tokens.reasoning) * openai.output) /
        1_000_000,
      source: "OpenAI pricing",
    };
  }

  const minimax = provider.includes("minimax") || modelKey.includes("minimax")
    ? MINIMAX_PRICING_PER_MILLION_CNY[modelKey.replace(/^minimax-/, "minimax-")]
    : undefined;

  if (minimax) {
    const cny =
      (tokens.input * minimax.input +
        tokens.output * minimax.output +
        tokens.reasoning * minimax.output +
        tokens.cacheRead * minimax.cacheRead +
        tokens.cacheWrite * minimax.cacheWrite) /
      1_000_000;

    return {
      cost: cny / MINIMAX_CNY_PER_USD,
      source: `MiniMax pricing, CNY/USD ${MINIMAX_CNY_PER_USD}`,
    };
  }

  const gemini = provider === "google" ? GEMINI_PRICING_PER_MILLION[modelKey] : undefined;

  if (gemini) {
    const price = tokens.input + tokens.cacheRead + tokens.cacheWrite > gemini.threshold ? gemini.long : gemini.short;
    return {
      cost:
        ((tokens.input + tokens.cacheWrite) * price.input +
          tokens.cacheRead * price.cachedInput +
          (tokens.output + tokens.reasoning) * price.output) /
        1_000_000,
      source: "Google Gemini pricing",
    };
  }

  return {
    cost: recordedCost,
    source: recordedCost > 0 ? "Recorded by opencode" : "Unavailable",
  };
}

function aggregateUsage() {
  const db = new Database(DB_PATH, { readonly: true });
  const maxRow = db.query("select max(rowid) as max from message").get()?.max ?? 0;
  const usage = new Map();

  for (let start = 1; start <= maxRow; start += 500) {
    const end = start + 499;
    const rows = db
      .query(`select time_created, data from message where rowid between ${start} and ${end}`)
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

      if (inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens <= 0) {
        continue;
      }

      const month = monthKey(row.time_created);
      const provider = data.providerID ?? "unknown";
      const model = data.modelID ?? "unknown";
      const key = `${month}\t${provider}\t${model}`;
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

      const pricing = calculateMessageCost(
        provider,
        model,
        {
          input: inputTokens,
          output: outputTokens,
          reasoning: reasoningTokens,
          cacheRead: cacheReadTokens,
          cacheWrite: cacheWriteTokens,
        },
        recordedCost,
      );

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
    {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      calculatedCost: 0,
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    source: DB_PATH,
    months: [...new Set(rows.map((row) => row.month))],
    models: [...new Set(rows.map((row) => `${row.provider}/${row.model}`))],
    totals,
    rows,
  };
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>opencode Token Consumption</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f17;
      --panel: #121928;
      --panel-2: #172033;
      --text: #edf2ff;
      --muted: #9aa9c2;
      --grid: rgba(255, 255, 255, 0.08);
      --line: rgba(255, 255, 255, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 12% 0%, #203154 0, transparent 28rem), var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 32px 20px 48px; }
    header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-end; margin-bottom: 24px; }
    h1 { margin: 0; font-size: clamp(28px, 5vw, 56px); letter-spacing: -0.06em; line-height: 0.95; }
    .subtitle { margin-top: 10px; color: var(--muted); max-width: 760px; }
    .pill { padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); white-space: nowrap; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    .card, .panel { background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)), var(--panel); border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 18px 60px rgba(0,0,0,0.28); }
    .card { padding: 18px; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; }
    .value { margin-top: 8px; font-size: clamp(22px, 3vw, 34px); font-weight: 800; letter-spacing: -0.04em; }
    .panel { padding: 18px; margin-top: 14px; overflow: hidden; }
    .chart-wrap { overflow-x: auto; padding-bottom: 8px; }
    .chart { min-width: 860px; height: 440px; display: grid; grid-template-columns: 54px 1fr; grid-template-rows: 1fr 42px; gap: 0 12px; }
    .axis { grid-row: 1; display: flex; flex-direction: column; justify-content: space-between; color: var(--muted); font-size: 12px; text-align: right; padding-right: 4px; }
    .plot { position: relative; grid-column: 2; grid-row: 1; border-left: 1px solid var(--line); border-bottom: 1px solid var(--line); display: flex; align-items: end; gap: 24px; padding: 0 18px; }
    .plot::before { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(to top, var(--grid), var(--grid) 1px, transparent 1px, transparent 20%); pointer-events: none; }
    .bar-group { position: relative; z-index: 1; flex: 1; min-width: 90px; height: 100%; display: flex; align-items: end; justify-content: center; }
    .bar { width: min(72px, 70%); min-height: 1px; border-radius: 10px 10px 0 0; overflow: hidden; background: var(--panel-2); display: flex; flex-direction: column-reverse; box-shadow: 0 12px 30px rgba(0,0,0,0.28); }
    .segment { width: 100%; min-height: 1px; border-top: 1px solid rgba(255,255,255,0.18); }
    .x-axis { grid-column: 2; grid-row: 2; display: flex; gap: 24px; padding: 10px 18px 0; color: var(--muted); }
    .x-axis div { flex: 1; min-width: 90px; text-align: center; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 14px; color: var(--muted); }
    .legend span { display: inline-flex; align-items: center; gap: 7px; }
    .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td { padding: 11px 10px; border-bottom: 1px solid var(--line); text-align: right; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; position: sticky; top: 0; background: var(--panel); }
    .table-wrap { overflow: auto; max-height: 560px; }
    .error { border-color: rgba(255, 96, 96, 0.45); color: #ffb4b4; padding: 18px; }
    @media (max-width: 760px) {
      header { display: block; }
      .pill { display: inline-block; margin-top: 14px; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>opencode Token Consumption</h1>
        <div class="subtitle">Monthly usage grouped by model. Each column is one month; each colored stack is a model. The table below breaks down input tokens, output tokens, reasoning/cache tokens, calls, and recorded price.</div>
      </div>
      <div class="pill" id="generated">Loading...</div>
    </header>

    <section class="cards">
      <div class="card"><div class="label">Total Tokens</div><div class="value" id="totalTokens">-</div></div>
      <div class="card"><div class="label">Input Tokens</div><div class="value" id="inputTokens">-</div></div>
      <div class="card"><div class="label">Output Tokens</div><div class="value" id="outputTokens">-</div></div>
      <div class="card"><div class="label">Calculated Price</div><div class="value" id="cost">-</div></div>
    </section>

    <section class="panel">
      <div class="chart-wrap"><div class="chart" id="chart"></div></div>
      <div class="legend" id="legend"></div>
    </section>

    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-key="month" data-type="text">Month</th><th data-key="modelLabel" data-type="text">Model</th><th data-key="calls" data-type="number">Calls</th><th data-key="inputTokens" data-type="number">Input</th><th data-key="outputTokens" data-type="number">Output</th><th data-key="reasoningTokens" data-type="number">Reasoning</th><th data-key="cacheReadTokens" data-type="number">Cache Read</th><th data-key="cacheWriteTokens" data-type="number">Cache Write</th><th data-key="totalTokens" data-type="number">Total</th><th data-key="calculatedCost" data-type="number">Price</th><th data-key="priceSource" data-type="text">Price Source</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const colors = ["#7dd3fc", "#c084fc", "#f472b6", "#fb7185", "#fbbf24", "#34d399", "#60a5fa", "#a3e635", "#f97316", "#2dd4bf", "#e879f9", "#93c5fd"];
    const fmt = new Intl.NumberFormat();
    const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
    const total = row => row.inputTokens + row.outputTokens + row.reasoningTokens + row.cacheReadTokens + row.cacheWriteTokens;
    let tableRows = [];
    let sortState = { key: "month", direction: "asc", type: "text" };

    function render(data) {
      const modelColors = Object.fromEntries(data.models.map((model, index) => [model, colors[index % colors.length]]));
      const monthTotals = Object.fromEntries(data.months.map(month => [month, data.rows.filter(row => row.month === month).reduce((sum, row) => sum + total(row), 0)]));
      const max = Math.max(...Object.values(monthTotals), 1);
      const grandTotal = data.totals.inputTokens + data.totals.outputTokens + data.totals.reasoningTokens + data.totals.cacheReadTokens + data.totals.cacheWriteTokens;

      document.getElementById("generated").textContent = "Generated " + new Date(data.generatedAt).toLocaleString();
      document.getElementById("totalTokens").textContent = fmt.format(grandTotal);
      document.getElementById("inputTokens").textContent = fmt.format(data.totals.inputTokens);
      document.getElementById("outputTokens").textContent = fmt.format(data.totals.outputTokens);
      document.getElementById("cost").textContent = money.format(data.totals.calculatedCost);

      const marks = [1, 0.75, 0.5, 0.25, 0].map(value => "<div>" + fmt.format(Math.round(max * value)) + "</div>").join("");
      const bars = data.months.map(month => {
        const height = monthTotals[month] / max * 100;
        const segments = data.rows.filter(row => row.month === month).map(row => {
          const model = row.provider + "/" + row.model;
          const segmentHeight = total(row) / monthTotals[month] * 100;
          const title = month + " " + model + "\nTotal: " + fmt.format(total(row)) + "\nInput: " + fmt.format(row.inputTokens) + "\nOutput: " + fmt.format(row.outputTokens) + "\nPrice: " + money.format(row.calculatedCost) + "\nSource: " + row.priceSource;
          return "<div class=\"segment\" title=\"" + title + "\" style=\"height:" + segmentHeight + "%;background:" + modelColors[model] + "\"></div>";
        }).join("");
        return "<div class=\"bar-group\"><div class=\"bar\" style=\"height:" + height + "%\">" + segments + "</div></div>";
      }).join("");
      const labels = data.months.map(month => "<div>" + month + "</div>").join("");
      document.getElementById("chart").innerHTML = "<div class=\"axis\">" + marks + "</div><div class=\"plot\">" + bars + "</div><div class=\"x-axis\">" + labels + "</div>";
      document.getElementById("legend").innerHTML = data.models.map(model => "<span><i class=\"swatch\" style=\"background:" + modelColors[model] + "\"></i>" + model + "</span>").join("");

      tableRows = data.rows.map(row => ({
        ...row,
        modelLabel: row.provider + "/" + row.model,
        totalTokens: total(row),
      }));
      document.querySelectorAll("th[data-key]").forEach(th => {
        th.style.cursor = "pointer";
        th.title = "Click to sort";
        th.addEventListener("click", () => {
          const key = th.dataset.key;
          const type = th.dataset.type;
          sortState = {
            key,
            type,
            direction: sortState.key === key && sortState.direction === "desc" ? "asc" : "desc",
          };
          renderRows();
        });
      });
      renderRows();
    }

    function renderRows() {
      const rows = [...tableRows].sort((a, b) => {
        const aValue = a[sortState.key];
        const bValue = b[sortState.key];
        const result = sortState.type === "number"
          ? Number(aValue ?? 0) - Number(bValue ?? 0)
          : String(aValue ?? "").localeCompare(String(bValue ?? ""));
        return sortState.direction === "asc" ? result : -result;
      });

      document.querySelectorAll("th[data-key]").forEach(th => {
        const label = th.textContent.replace(/ [▲▼]$/, "");
        th.textContent = label + (th.dataset.key === sortState.key ? (sortState.direction === "asc" ? " ▲" : " ▼") : "");
      });

      document.getElementById("rows").innerHTML = rows.map(row => {
        const model = row.provider + "/" + row.model;
        return "<tr><td>" + row.month + "</td><td>" + model + "</td><td>" + fmt.format(row.calls) + "</td><td>" + fmt.format(row.inputTokens) + "</td><td>" + fmt.format(row.outputTokens) + "</td><td>" + fmt.format(row.reasoningTokens) + "</td><td>" + fmt.format(row.cacheReadTokens) + "</td><td>" + fmt.format(row.cacheWriteTokens) + "</td><td>" + fmt.format(row.totalTokens) + "</td><td>" + money.format(row.calculatedCost) + "</td><td>" + row.priceSource + "</td></tr>";
      }).join("");
    }

    fetch("/api/usage")
      .then(response => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(render)
      .catch(error => {
        document.querySelector("main").insertAdjacentHTML("beforeend", "<section class=\"panel error\">Could not load usage data: " + error.message + "</section>");
      });
  </script>
</body>
</html>`;

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

console.log(`opencode usage dashboard: http://localhost:${PORT}`);
console.log(`database: ${DB_PATH}`);
