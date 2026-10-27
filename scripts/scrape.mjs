import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const URL = "https://www.migration.tas.gov.au/news/processing_times_and_allocation_usage";
const OUT = "site/data.json";
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
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
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) throw new Error("Bad date: " + s);
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
  if (st < 0) throw new Error("Section not found: " + H[0]);
  t = t.slice(st);
  const idx = H.map((h) => {
    const i = t.indexOf(h);
    if (i < 0) throw new Error("Section not found: " + h);
    return i;
  });
  const sec = (i) => t.slice(idx[i], idx[i + 1] ?? t.length);
  const num = (i, k) => {
    const m = sec(i).match(new RegExp(`Subclass ${k} - (\\d+)`));
    if (!m) throw new Error(`No number for subclass ${k} in "${H[i]}"`);
    return +m[1];
  };
  const s = {};
  for (const k of ["190", "491"]) {
    const m = sec(0).match(new RegExp(`Subclass ${k} - (\\d+) invitations(.*?)(?=Subclass \\d{3}|$)`));
    if (!m) throw new Error(`No invitations line for subclass ${k}`);
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
  const roundDate = iso(sec(0).match(/on (\d{1,2}\/\d{1,2}\/\d{4})/)?.[1] ?? "");
  const oldest = iso(sec(6));
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
