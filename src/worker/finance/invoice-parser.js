// Accounts Payable Cortex — AI-powered invoice extraction.
//
// Uses Workers AI (LLaVA for images, llama for text) to extract structured
// invoice fields from raw text or image payloads.
//
// Returns a normalized InvoiceData object. All amounts are in cents (integer).

const SYSTEM_PROMPT = `You are an accounts-payable data extractor.
Given invoice text, extract the following fields and return ONLY valid JSON (no markdown, no preamble):
{
  "vendorName": string | null,
  "invoiceNumber": string | null,
  "invoiceDate": "YYYY-MM-DD" | null,
  "dueDate": "YYYY-MM-DD" | null,
  "amountDue": number | null,      // total amount due as a decimal number
  "currency": "USD" | string,
  "description": string | null,    // brief description of goods/services
  "lineItems": [{"description": string, "amount": number}] | [],
  "taxCategory": "WA_BO" | "WA_SALES_TAX" | "FEDERAL_1099" | "NONE" | null
}
Rules:
- amountDue must be a plain decimal number (e.g. 1234.56), not a formatted string.
- If a field is not present in the invoice, use null.
- taxCategory: use WA_BO for B&O-taxable services in Washington; WA_SALES_TAX for retail/digital goods; FEDERAL_1099 for contractor payments ≥ $600; otherwise NONE.
- Do not hallucinate — only extract what is explicitly in the text.`;

/**
 * Extract invoice data from raw text using Workers AI (LLaMA).
 *
 * @param {object} env  - Cloudflare Worker env (needs env.AI)
 * @param {string} text - Raw invoice text
 * @returns {Promise<InvoiceData>}
 */
export async function extractFromText(env, text) {
  if (!env.AI) return { ok: false, error: 'AI binding missing' };
  const snippet = text.slice(0, 8_000);
  let raw;
  try {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Extract invoice data from the following text:\n\n${snippet}` },
      ],
      max_tokens: 800,
    });
    raw = (r?.response || '').trim();
  } catch (err) {
    return { ok: false, error: `AI extraction failed: ${err.message}` };
  }
  return parseExtracted(raw, text);
}

/**
 * Extract invoice data from an image (base64) via LLaVA → text → structured.
 *
 * @param {object} env        - Cloudflare Worker env (needs env.AI)
 * @param {Uint8Array} imageBytes
 * @returns {Promise<InvoiceData>}
 */
export async function extractFromImage(env, imageBytes) {
  if (!env.AI) return { ok: false, error: 'AI binding missing' };
  let captionText;
  try {
    const r = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: [...imageBytes],
      prompt: 'Read all text in this invoice image exactly as it appears, including all numbers, dates, vendor names, and totals.',
      max_tokens: 1024,
    });
    captionText = (r?.description || '').trim();
  } catch (err) {
    return { ok: false, error: `LLaVA caption failed: ${err.message}` };
  }
  if (!captionText) return { ok: false, error: 'LLaVA returned empty caption' };
  return extractFromText(env, captionText);
}

// ── helpers ───────────────────────────────────────────────────────────

function parseExtracted(raw, originalText) {
  // Strip markdown code fences if present
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let data;
  try {
    data = JSON.parse(clean);
  } catch {
    // Attempt to find JSON object in the response
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      try { data = JSON.parse(m[0]); } catch { return { ok: false, error: 'could not parse AI JSON output' }; }
    } else {
      return { ok: false, error: 'could not parse AI JSON output' };
    }
  }

  // Normalize amounts to cents (integer)
  const amountCents = data.amountDue != null
    ? Math.round(parseFloat(data.amountDue) * 100)
    : null;

  return {
    ok: true,
    vendorName: strOrNull(data.vendorName),
    invoiceNumber: strOrNull(data.invoiceNumber),
    invoiceDate: dateToMs(data.invoiceDate),
    dueDate: dateToMs(data.dueDate),
    amountCents: amountCents != null && Number.isFinite(amountCents) && amountCents >= 0
      ? amountCents
      : 0,
    currency: strOrNull(data.currency) ?? 'USD',
    description: strOrNull(data.description),
    lineItems: Array.isArray(data.lineItems) ? data.lineItems : [],
    taxCategory: validTaxCat(data.taxCategory),
    rawText: originalText,
  };
}

function strOrNull(v) {
  if (v == null || v === '') return null;
  return String(v).trim().slice(0, 500) || null;
}

function dateToMs(s) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

const TAX_CATS = new Set(['WA_BO', 'WA_SALES_TAX', 'FEDERAL_1099', 'NONE']);
function validTaxCat(v) {
  if (!v) return null;
  return TAX_CATS.has(String(v).toUpperCase()) ? String(v).toUpperCase() : null;
}
