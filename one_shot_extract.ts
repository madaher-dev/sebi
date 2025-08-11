/**
 * One-shot extractor: send a PDF to the model + Zod schema, get structured JSON of references.
 * Usage:
 *    ts-node one_shot_extract.ts <input.pdf> [--out refs.json] [--csv refs.csv]
 *     npm run extract -- sample2.pdf --out refs.json -- --csv refs.csv
 */
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";

dotenv.config();

// ---------- Zod schema for structured output ----------
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
  title: z.string().nullable(), // as written
  identifier: z.string().nullable(), // e.g., SEBI/HO/... or Regulation 12(3A)
  url: z.string().nullable(),
  anchorPageHint: z.number().int().nullable(),
  pages: z.array(z.number().int()).min(1),
  snippets: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});

const ReferenceList = z.array(ReferenceItem);

// Top-level must be an OBJECT, not an array
const ReferenceEnvelope = z.object({
  references: ReferenceList,
});
type ReferenceItem = z.infer<typeof ReferenceItem>;
type ReferenceEnvelope = z.infer<typeof ReferenceEnvelope>;

// ---------- Tiny arg parser ----------
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    "Usage: ts-node one_shot_extract.ts <input.pdf> [--out refs.json] [--csv refs.csv]"
  );
  process.exit(1);
}
const inputPdf = args[0];
const outJson = getFlagValue(args, "--out") || "refs.json";
const outCsv = getFlagValue(args, "--csv"); // optional

function getFlagValue(argv: string[], flag: string) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------- Helpers ----------
function fileToBase64(p: string) {
  const data = fs.readFileSync(p);
  return data.toString("base64");
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

// ---------- Prompt (brief but strict) ----------
const SYSTEM_INSTRUCTIONS = `
You are extracting **only explicit references** to other documents from a SEBI circular PDF.
Return a JSON array following the provided JSON Schema exactly. Rules:
- Do NOT invent titles, identifiers, or dates. Use only what is present in the PDF.
- Include all page numbers where each reference appears.
- If multiple items are cited together (e.g., "Regulation 12(3) and 12(3A)"), return **separate entries**.
- Prefer the title as written, else null. Keep identifiers precise (e.g., circular code, regulation number).
- Snippet must be a short exact quote (<=200 chars) containing the reference.
- If a URL includes an anchor like "#page=110", set anchorPageHint=110.
- If uncertain, lower confidence; do not fabricate.
`;

// ---------- Main ----------
(async () => {
  // Read & encode PDF
  const filename = path.basename(inputPdf);
  const base64 = fileToBase64(inputPdf);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (!client.apiKey) {
    console.error("ERROR: OPENAI_API_KEY is not set.");
    process.exit(1);
  }

  // Build message with file + instructions
  const inputMessage = [
    {
      role: "user" as const,
      content: [
        {
          type: "input_file" as const,
          filename,
          file_data: `data:application/pdf;base64,${base64}`,
        },
        {
          type: "input_text" as const,
          text: "Extract all references and return ONLY the JSON per the schema. No extra prose.",
        },
      ],
    },
  ];

  // Call Responses API with JSON schema output
  const response = await client.responses.create({
    model: "gpt-5", // or "gpt-4.1"
    // temperature: 0, // only for older models
    instructions: SYSTEM_INSTRUCTIONS.trim(),
    input: inputMessage,
    text: {
      format: zodTextFormat(ReferenceEnvelope, "references"),
    },
  });

  // Pull JSON — prefer output_text; fallback to scanning content blocks
  let text = (response as any).output_text as string | undefined;

  if (!text) {
    console.error("No output text from model.");
    process.exit(1);
  }

  // Parse & validate with Zod (guards against schema drift)
  let parsed: ReferenceItem[];
  try {
    const json = JSON.parse(text);
    const envelope = ReferenceEnvelope.parse(json);
    parsed = envelope.references;
  } catch (e) {
    console.error("Failed to parse/validate JSON output:", e);
    console.error(
      "Raw output was:",
      text.slice(0, 2000),
      text.length > 2000 ? "..." : ""
    );
    process.exit(1);
  }

  // Write JSON
  fs.writeFileSync(outJson, JSON.stringify(parsed, null, 2), "utf8");
  console.log(`✅ JSON written to ${outJson} (${parsed.length} items)`);

  // Optional CSV
  if (outCsv) {
    fs.writeFileSync(outCsv, toCsv(parsed), "utf8");
    console.log(`✅ CSV written to ${outCsv}`);
  }
})().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
