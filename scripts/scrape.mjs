import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const URL = "https://www.migration.tas.gov.au/news/processing_times_and_allocation_usage";
const OUT = "site/data.json";
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

// The headings your scraper looks for
const H = [
  "ROIs invited to apply for nomination on",
  "The lowest scores invited",
  "Number of ROIs on hand",
  "Nomination places available",
  "Nomination applications lodged but not yet decided",
  "Invitations issued but application not yet lodged",
  "Oldest nomination application",
  "Lowest point score required to gain nomination", 
];

const iso = (s) => {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null; // Graceful fallback instead of throwing error
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
};

export function toText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;|[–—]/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function parse(html) {
  let t = toText(html);
  const st = t.indexOf(H[0]);
  if (st < 0) throw new Error("Primary starting section not found: " + H[0]);
  t = t.slice(st);
  
  // Map indices. If a heading is missing, mark as -1 rather than crashing.
  const idx = H.map((h) => t.indexOf(h));
  
  // Safely extract sections even if some are missing
  const sec = (i) => {
    if (idx[i] < 0) return ""; 
    let nextIdx = t.length;
    for (let j = i + 1; j < idx.length; j++) {
      if (idx[j] >= 0) {
        nextIdx = idx[j];
        break;
      }
    }
    return t.slice(idx[i], nextIdx);
  };

  // Safely extract numbers. Default to 0 if section or subclass number is missing.
  const num = (i, k) => {
    if (idx[i] < 0) return 0; 
    const m = sec(i).match(new RegExp(`Subclass ${k} - (\\d+)`));
    return m ? +m[1] : 0; 
  };

  const s = {};
  for (const k of ["190", "491"]) {
    const m = sec(0).match(new RegExp(`Subclass ${k} - (\\d+) invitations(.*?)(?=Subclass \\d{3}|$)`));
    if (!m) {
      console.warn(`Warning: No invitations line found for subclass ${k}`);
      s[k] = { invited: 0, gold: 0, second: 0, lowInv: 0, roi: 0, places: 0, lodged: 0, notLodged: 0, lowRoll: 0 };
      continue;
    }
    s[k] = {
      invited: +m[1],
      gold: +(m[2].match(/(\d+) Gold/i)?.[1] ?? 0),
      second: +(m[2].match(/(\d+) (?:Green|further)/i)?.[1] ?? 0),
      lowInv: num(1, k),
      roi: num(2, k),
      places: num(3, k),
      lodged: num(4, k),
      notLodged: num(5, k),
      lowRoll: num(7, k),
    };
  }

  const roundDateMatch = sec(0).match(/on (\d{1,2}\/\d{1,2}\/\d{4})/);
  const roundDate = roundDateMatch ? iso(roundDateMatch[1]) : "";
  const oldest = iso(sec(6)) || "";
  
  const u = t.match(/last updated on (\d{1,2}) (\w+) (\d{4})/i);
  const updated = u
    ? `${u[3]}-${String(MONTHS.indexOf(u[2].toLowerCase()) + 1).padStart(2, "0")}-${u[1].padStart(2, "0")}`
    : roundDate;
    
  return { updated, roundDate, oldest, s };
}

async function getPage() {
  const tries = [
    [URL, {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-AU,en;q=0.9",
    }],
    ["https://r.jina.ai/" + URL, { accept: "text/plain" }],
  ];
  
  for (const [u, headers] of tries) {
    try {
      const res = await fetch(u, { headers });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      // Test parse to ensure we got valid data before returning
      parse(text); 
      return text;
    } catch (e) {
      console.log("Source failed:", u, "-", e.message);
    }
  }
  throw new Error("Could not read the page from any source");
}

async function main() {
  const cur = parse(await getPage());
  mkdirSync("site", { recursive: true });
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { history: [] };
  const history = prev.history ?? [];
  const last = history.at(-1);
  const sig = (x) => JSON.stringify([x.roundDate, x.s]);
  
  if (last && sig(last) === sig(cur) && prev.updated === cur.updated && prev.oldest === cur.oldest) {
    console.log("No change.");
    return;
  }
  
  if (!last || sig(last) !== sig(cur)) {
    history.push({ date: cur.updated, roundDate: cur.roundDate, s: cur.s });
  }
  
  const out = { fetchedAt: new Date().toISOString(), ...cur, history: history.slice(-400) };
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log("Saved new data for", cur.updated);
}

if (process.argv[1]?.endsWith("scrape.mjs")) {
  main().catch((e) => { console.error("Scrape failed:", e.message); process.exit(1); });
}
