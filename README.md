# SEBI Circular Reference Extractor

Extract cross-references (circulars, master circulars, regulations, act sections, schedules, clauses, exchange/depository notices, URLs) with page numbers and proof snippets from SEBI PDFs.

## Requirements

Node 18+

OpenAI API key (Responses API + structured output)

## Setup

npm install
cp .env.example .env # set OPENAI_API_KEY=sk-...

## Quick Start

One-shot (quick & simple)
Sends the whole PDF to the model; returns structured JSON.

npm run extract -- sample2.pdf --out refs.json -- --csv refs.csv

Hybrid (recommended for production)
Parses the PDF page-true, finds candidates via regex, then uses the model only to normalize them (cheaper, auditable).

With LLM normalization

npm run hybrid -- sample2.pdf --out refs.hybrid.json -- --csv refs.hybrid.csv

Without LLM - Rules-only (offline/cheap)

npm run hybrid -- sample2.pdf --out refs.rules.json -- --csv refs.rules.csv --no-llm

For Larger normalization batches (default 40)
npm run hybrid -- sample2.pdf --out refs.hybrid.json -- --batch 60

## Output

Both scripts write:

JSON (authoritative): array of references with
type, title, identifier, url, anchorPageHint, pages[], snippets[], confidence

CSV (optional): same info, compacted for quick review.

## Which approach?

One-shot: fastest to try; may be costlier on long PDFs and less page-accurate.

Hybrid: page-true, explainable, and cheaper at scale; best for compliance.

## Tips

On Windows with npm scripts, pass an extra -- before your last flags so they reach the script:
npm run extract -- <file> --out <json> -- --csv <csv>

## Files

one_shot_extract.ts — single Responses API call with Zod output

hybrid_extract.ts — pdfjs page parsing → regex candidates → Responses API normalization

sample1.pdf — example input
sample2.pdf — example input

.env.example — template for your API key
