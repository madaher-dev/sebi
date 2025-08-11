#!/usr/bin/env tsx
/**
 * Hybrid extractor: page-true parsing + regex candidates + LLM normalization.
 * Usage:
 *   npm run hybrid -- sample2.pdf --out refs.hybrid.json --csv refs.hybrid.csv
 *   # options: --no-llm (rules-only), --batch 40
 */

import * as dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import { z } from "zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

// ---------- Zod schemas ----------
const ReferenceItem = z.object({
  type: z.enum([
    "Circular",
    "Master Circular",
    "Regulation",
    "Act Section",
    "Schedule",
    "Chapter",
    "Clause",
    "Stock Exchange Circular",
    "Depository Circular",
    "URL",
    "Other",
  ]),
  title: z.string().nullable(),
  identifier: z.string().nullable(),
  url: z.string().nullable(), // no .url()
  anchorPageHint: z.number().int().nullable(),
  pages: z.array(z.number().int()).min(1),
  snippets: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});

const ReferenceEnvelope = z.object({
  references: z.array(ReferenceItem),
});

type ReferenceItem = z.infer<typeof ReferenceItem>;
type ReferenceEnvelope = z.infer<typeof ReferenceEnvelope>;

// Candidates from rule pass
const CandidateKind = z.enum([
  "circularCode",
  "masterCircular",
  "regulationSet",
  "regulation",
  "actSection",
  "schedule",
  "chapter",
  "clause",
  "url",
]);
type CandidateKind = z.infer<typeof CandidateKind>;

const Candidate = z.object({
  page: z.number().int(), // 1-based page number
  sentence: z.string(), // sentence containing the hit
  match: z.string(), // exact regex match
  kind: CandidateKind, // which rule matched
  url: z.string().nullable(), // first URL seen in the sentence (if any)
});
type Candidate = z.infer<typeof Candidate>;

// ---------- CLI args ----------
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    "Usage: npm run hybrid -- <input.pdf> [--out refs.hybrid.json] [--csv refs.hybrid.csv] [--no-llm] [--batch 40]"
  );
  process.exit(1);
}
const inputPdf = args[0];
const outJson = getFlagValue(args, "--out") || "refs.hybrid.json";
const outCsv = getFlagValue(args, "--csv"); // optional
const noLlm = args.includes("--no-llm");
const batchSize = parseInt(getFlagValue(args, "--batch") || "40", 10);

function getFlagValue(argv: string[], flag: string) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------- Regex patterns ----------
const PATTERNS: Record<CandidateKind, RegExp> = {
  circularCode: /SEBI\/HO\/[A-Z0-9/-]+\/P?\/CIR\/\d{4}\/\d+/g,
  masterCircular:
    /\bMaster Circular (?:for|on)\s+[^.,;\n]+?(?:dated\s+[A-Z][a-z]+\s+\d{1,2},\s*\d{4})?/gi,
  regulationSet: /SEBI\s*\([^)]+\)\s*Regulations,\s*\d{4}/gi,
  regulation: /\bRegulation(?:s)?\s+\d+(?:\([0-9A-Za-z]+\))*/g,
  actSection: /\bSection\s+\d+(?:\(\d+\))*\s+of the\s+[^.,\n]+?Act,\s*\d{4}/gi,
  schedule: /\bSchedule\s+[IVXLC]+\b/g,
  chapter: /\bChapter\s+\d+\b/g,
  clause: /\bClause\s+\d+(?:\.\d+)*\b/g,
  url: /\bhttps?:\/\/\S+/gi,
};

// ---------- Helpers ----------

// Keeps sentences aligned to pages (crucial for auditability).
// De-hyphenation improves regex recall.
function dehyphenate(input: string): string {
  // Join hyphenated line breaks: e.g., "regula-\ntions" -> "regulations"
  let s = input.replace(/-\s*\n\s*/g, "");
  // Normalize newlines to spaces, collapsing multiple spaces
  s = s
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ");
  return s;
}

function splitSentences(text: string): string[] {
  // Conservative sentence splitter for legal prose
  const chunks = text
    .split(/(?<=[\.\?\!;])\s+(?=[A-Z(“"'])/g)
    .map((t) => t.trim())
    .filter(Boolean);
  return chunks.length ? chunks : [text.trim()];
}

function toCsv(rows: ReferenceItem[]): string {
  const esc = (s: string | number | null | undefined) => {
    const v = s === null || s === undefined ? "" : String(s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const header = [
    "type",
    "title",
    "identifier",
    "url",
    "anchorPageHint",
    "pages",
    "first_page",
    "snippets",
    "confidence",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        esc(r.type),
        esc(r.title ?? ""),
        esc(r.identifier ?? ""),
        esc(r.url ?? ""),
        esc(r.anchorPageHint ?? ""),
        esc(r.pages.join("|")),
        esc(Math.min(...r.pages)),
        esc(r.snippets.join(" | ")),
        esc(r.confidence),
      ].join(",")
    );
  }
  return lines.join("\n");
}

// ---------- PDF extraction ----------
async function extractPages(pdfPath: string): Promise<
  Array<{
    page: number;
    text: string;
    urls: string[];
  }>
> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await (pdfjsLib as any).getDocument({ data }).promise;
  const out: Array<{ page: number; text: string; urls: string[] }> = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = dehyphenate(
      (textContent.items as any[])
        .map((it) =>
          typeof it.str === "string" ? it.str : (it as any).str || ""
        )
        .join(" ")
    );

    const annots = await page.getAnnotations();
    const urls = (annots as any[])
      .filter((a) => a && a.subtype === "Link" && a.url)
      .map((a) => String(a.url));

    out.push({ page: i, text, urls });
  }

  try {
    await doc.destroy();
  } catch {}
  return out;
}

// ---------- Candidate finder ----------
function findCandidates(
  pages: Array<{ page: number; text: string; urls: string[] }>
): Candidate[] {
  const results: Candidate[] = [];
  for (const p of pages) {
    const sentences = splitSentences(p.text);
    for (const s of sentences) {
      const urlInSentence = (s.match(PATTERNS.url) || [])[0] ?? null;
      (Object.entries(PATTERNS) as Array<[CandidateKind, RegExp]>).forEach(
        ([kind, rx]) => {
          const matches = s.match(rx) || [];
          for (const m of matches) {
            results.push({
              page: p.page,
              sentence: s.trim(),
              match: m.trim(),
              kind,
              url: urlInSentence,
            });
          }
        }
      );
    }
    // Include page-level link annotations as URL candidates
    for (const u of p.urls) {
      results.push({
        page: p.page,
        sentence: "",
        match: u,
        kind: "url",
        url: u,
      });
    }
  }

  // Deduplicate exact duplicates (same page, sentence, match, kind)
  const uniq = new Map<string, Candidate>();
  for (const c of results) {
    const k = `${c.page}|${c.kind}|${c.match}|${c.sentence}`;
    if (!uniq.has(k)) uniq.set(k, c);
  }
  return Array.from(uniq.values());
}

// ---------- LLM normalization ----------
async function normalizeWithLLM(
  allCandidates: Candidate[],
  batch = 40
): Promise<ReferenceItem[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set in environment.");
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const SYSTEM = `
You are normalizing legal/reference candidates extracted from a SEBI circular.
For each candidate, emit zero or more normalized references following the schema.
Rules:
- Use ONLY information present in the candidate sentence and match text.
- If multiple items are present (e.g., "Regulation 12(3) and 12(3A)"), emit separate entries.
- title is the as-written title if present, else null.
- identifier is a precise code or number (circular code, Regulation number, Section).
- Include the source page and a short snippet (<=200 chars) containing the reference.
- If a URL includes "#page=110", set anchorPageHint=110.
- Never invent text; lower confidence if unsure.
`;

  const out: ReferenceItem[] = [];
  for (let i = 0; i < allCandidates.length; i += batch) {
    const slice = allCandidates.slice(i, i + batch);
    const inputObj = slice.map((c) => ({
      page: c.page,
      sentence: c.sentence,
      match: c.match,
      kind: c.kind,
      url: c.url,
    }));

    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      instructions: SYSTEM.trim(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Normalize these candidates into references. Return only JSON per the schema.\n" +
                JSON.stringify(inputObj),
            },
          ],
        },
      ],
      text: {
        format: zodTextFormat(ReferenceEnvelope, "ReferenceEnvelope"),
      },
    });

    const text = resp.output_text!;
    const env = ReferenceEnvelope.parse(JSON.parse(text));
    out.push(...env.references);
  }
  return out;
}

// ---------- Dedupe & merge ----------
// Collapses duplicates across pages, preserving first-class evidence (snippets) and max confidence.

function dedupe(items: ReferenceItem[]): ReferenceItem[] {
  const key = (r: ReferenceItem) =>
    `${r.type}|${(r.identifier || "").toLowerCase()}|${(
      r.title || ""
    ).toLowerCase()}`;
  const map = new Map<string, ReferenceItem>();
  for (const r of items) {
    const k = key(r);
    const found = map.get(k);
    if (!found) {
      // sort pages on insert
      r.pages = Array.from(new Set(r.pages)).sort((a, b) => a - b);
      r.snippets = Array.from(new Set(r.snippets));
      map.set(k, r);
    } else {
      found.pages = Array.from(new Set([...found.pages, ...r.pages])).sort(
        (a, b) => a - b
      );
      found.snippets = Array.from(new Set([...found.snippets, ...r.snippets]));
      found.confidence = Math.max(found.confidence, r.confidence);
      if (!found.url && r.url) found.url = r.url;
      if (!found.anchorPageHint && r.anchorPageHint)
        found.anchorPageHint = r.anchorPageHint;
    }
  }
  return Array.from(map.values());
}

// ---------- Main ----------
(async () => {
  // 1) Extract pages (text + links)
  const pages = await extractPages(inputPdf);

  // 2) Rule-based candidates
  const candidates = findCandidates(pages);
  if (!candidates.length) {
    console.log("No candidates found by rules. Exiting.");
    fs.writeFileSync(outJson, JSON.stringify([], null, 2), "utf8");
    process.exit(0);
  }

  // 3) Normalize with LLM (unless --no-llm)
  let normalized: ReferenceItem[];
  if (noLlm) {
    // Rules-only: cast candidates to minimal items with low confidence
    normalized = candidates.map<ReferenceItem>((c) => ({
      type:
        c.kind === "masterCircular"
          ? "Master Circular"
          : c.kind === "circularCode"
          ? "Circular"
          : c.kind === "regulation" || c.kind === "regulationSet"
          ? "Regulation"
          : c.kind === "actSection"
          ? "Act Section"
          : c.kind === "schedule"
          ? "Schedule"
          : c.kind === "chapter"
          ? "Chapter"
          : c.kind === "clause"
          ? "Clause"
          : c.kind === "url"
          ? "URL"
          : "Other",
      title: null,
      identifier:
        c.kind === "circularCode" || c.kind === "regulation" ? c.match : null,
      url: c.kind === "url" ? c.match : c.url,
      anchorPageHint: null,
      pages: [c.page],
      snippets: [c.sentence || c.match],
      confidence: 0.4,
    }));
  } else {
    normalized = await normalizeWithLLM(candidates, batchSize);
  }

  // 4) Dedupe/merge
  const merged = dedupe(normalized);

  // 5) Write outputs
  fs.writeFileSync(outJson, JSON.stringify(merged, null, 2), "utf8");
  console.log(`✅ JSON written to ${outJson} (${merged.length} items)`);

  if (outCsv) {
    fs.writeFileSync(outCsv, toCsv(merged), "utf8");
    console.log(`✅ CSV written to ${outCsv}`);
  }
})().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
