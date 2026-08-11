import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

let _gemini = null;
function getGemini() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY not configured');
  }
  if (!_gemini) {
    _gemini = new GoogleGenAI({ apiKey });
  }
  return _gemini;
}

const SUPPORTED_PROVIDERS = new Set(['gemini', 'openai']);
const requestedDefaultProvider = String(
  process.env.TRANSLATION_BATCH_PROVIDER
  || process.env.TRANSLATION_PROVIDER
  || 'gemini'
).toLowerCase();
const DEFAULT_PROVIDER = SUPPORTED_PROVIDERS.has(requestedDefaultProvider)
  ? requestedDefaultProvider
  : 'gemini';
const DEFAULT_MODEL = process.env.TRANSLATION_BATCH_MODEL
  || (DEFAULT_PROVIDER === 'openai' ? 'gpt-4o-mini' : 'gemini-2.5-flash-lite');
const MAX_RETRIES = 2;

function inferProvider(model = '') {
  const value = String(model || '').trim().toLowerCase();
  if (value.startsWith('gemini-')) return 'gemini';
  if (value.startsWith('gpt-') || value.startsWith('o1') || value.startsWith('o3') || value.startsWith('o4')) return 'openai';
  return DEFAULT_PROVIDER;
}

function normalizeModel(model = '') {
  const value = String(model || '').trim();
  if (value) return value;
  return DEFAULT_MODEL;
}

function toGeminiRequest(file, systemMessage, model) {
  return {
    key: `idx::${file.fileIndex}`,
    request: {
      contents: [
        {
          role: 'user',
          parts: [{ text: file.content }],
        },
      ],
      system_instruction: {
        parts: [{ text: systemMessage }],
      },
      generation_config: {
        temperature: 0.3,
        max_output_tokens: 16000,
      },
    },
  };
}

function mapGeminiState(state) {
  switch (String(state || '')) {
    case 'JOB_STATE_PENDING':
      return 'validating';
    case 'JOB_STATE_RUNNING':
      return 'in_progress';
    case 'JOB_STATE_SUCCEEDED':
      return 'completed';
    case 'JOB_STATE_FAILED':
      return 'failed';
    case 'JOB_STATE_CANCELLED':
      return 'cancelled';
    case 'JOB_STATE_EXPIRED':
      return 'expired';
    default:
      return String(state || '').toLowerCase() || 'unknown';
  }
}

function extractGeminiRequestCounts(batchJob) {
  const stats = batchJob?.batchStats || {};
  const completed = Number(stats.completedRequestCount || 0);
  const failed = Number(stats.failedRequestCount || 0);
  const total = Number(stats.totalRequestCount || completed + failed || 0);
  return { total, completed, failed };
}

async function downloadGeminiFileText(fileName) {
  const downloadPath = path.join('/tmp', `gemini-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  await getGemini().files.download({ file: fileName, downloadPath });
  try {
    return fs.readFileSync(downloadPath, 'utf8');
  } finally {
    try {
      fs.unlinkSync(downloadPath);
    } catch {}
  }
}

export function sanitizeTranslatedTemplate(content) {
  if (typeof content !== 'string') {
    return '';
  }

  const normalized = content.replace(/\r\n/g, '\n').replace(/—/g, '-');
  const trimmed = normalized.trim();
  const fenceMatch = trimmed.match(/^```(?:[a-z0-9_-]+)?\s*\n([\s\S]*?)\n```$/i);

  if (fenceMatch) {
    console.log('🧹 [sanitizeTranslatedTemplate] Stripped markdown code fence from translation output');
    return fenceMatch[1].trim();
  }

  return trimmed;
}

// ─── JSONL Generation ──────────────────────────────────────────

/**
 * Build request payload for the configured Batch API provider.
 */
export function createBatchJsonl(files, systemMessageFn, model = DEFAULT_MODEL) {
  const normalizedModel = normalizeModel(model);
  const provider = inferProvider(normalizedModel);
  const lines = [];
  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file.content || !file.lang) { skipped++; continue; }
    const indexedFile = {
      ...file,
      fileIndex: Number.isInteger(file.fileIndex) ? file.fileIndex : i,
    };
    const line = provider === 'gemini'
      ? toGeminiRequest(indexedFile, systemMessageFn(file.lang), normalizedModel)
      : {
          custom_id: `idx::${indexedFile.fileIndex}`,
          method: 'POST',
          url: '/v1/chat/completions',
          body: {
            model: normalizedModel,
            messages: [
              { role: 'system', content: systemMessageFn(file.lang) },
              { role: 'user', content: file.content },
            ],
            max_completion_tokens: 16000,
            temperature: 0.3,
          },
        };
    lines.push(JSON.stringify(line));
  }
  const jsonl = lines.join('\n');
  console.log(`📝 [createBatchJsonl] Generated ${lines.length} lines (${skipped} skipped), provider: ${provider}, model: ${normalizedModel}, size: ${jsonl.length} bytes`);
  return jsonl;
}

// ─── Upload & Start Batch ──────────────────────────────────────

/**
 * Upload JSONL to the active provider's file API, then create a batch.
 * Returns { batchId, inputFileId, status, requestCounts, provider, model }
 */
export async function uploadAndStartBatch(jsonlContent, model = DEFAULT_MODEL) {
  const normalizedModel = normalizeModel(model);
  const provider = inferProvider(normalizedModel);

  if (provider === 'gemini') {
    const tempPath = path.join('/tmp', `translations_${Date.now()}.jsonl`);
    fs.writeFileSync(tempPath, jsonlContent, 'utf8');

    try {
      const uploaded = await getGemini().files.upload({
        file: tempPath,
        config: {
          displayName: path.basename(tempPath),
          mimeType: 'jsonl',
        },
      });
      console.log(`📤 Uploaded Gemini JSONL file: ${uploaded.name} (${jsonlContent.length} bytes)`);

      const batch = await getGemini().batches.create({
        model: normalizedModel,
        src: uploaded.name,
        config: {
          displayName: `rental-translation-${Date.now()}`,
        },
      });

      console.log(`🚀 Gemini batch created: ${batch.name}, state: ${batch.state}`);

      return {
        provider,
        model: normalizedModel,
        batchId: batch.name,
        inputFileId: uploaded.name,
        status: mapGeminiState(batch.state),
        requestCounts: extractGeminiRequestCounts(batch),
      };
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
  }

  // Upload JSONL as a file
  const blob = new Blob([jsonlContent], { type: 'application/jsonl' });
  const file = new File([blob], `translations_${Date.now()}.jsonl`, { type: 'application/jsonl' });

  const uploaded = await getOpenAI().files.create({
    file,
    purpose: 'batch',
  });
  console.log(`📤 Uploaded JSONL file: ${uploaded.id} (${jsonlContent.length} bytes)`);

  // Create batch
  const batch = await getOpenAI().batches.create({
    input_file_id: uploaded.id,
    endpoint: '/v1/chat/completions',
    completion_window: '24h',
    metadata: {
      source: 'rental-translation',
      created: new Date().toISOString(),
    },
  });
  console.log(`🚀 Batch created: ${batch.id}, status: ${batch.status}`);

  return {
    provider,
    model: normalizedModel,
    batchId: batch.id,
    inputFileId: uploaded.id,
    status: batch.status,
    requestCounts: batch.request_counts,
  };
}

// ─── Poll Status ───────────────────────────────────────────────

/**
 * Check batch status. Returns full batch object with request_counts.
 */
export async function pollBatchStatus(batchId, provider = null) {
  const batchProvider = provider || inferProvider(batchId);

  if (batchProvider === 'gemini') {
    const batch = await getGemini().batches.get({ name: batchId });
    const requestCounts = extractGeminiRequestCounts(batch);
    console.log(`🔍 [pollBatchStatus] ${batchId}: ${batch.state} — completed: ${requestCounts.completed}/${requestCounts.total}, failed: ${requestCounts.failed}`);
    return {
      id: batch.name,
      status: mapGeminiState(batch.state),
      requestCounts,
      outputFileId: batch.dest?.fileName || null,
      errorFileId: batch.error?.details?.fileName || null,
      createdAt: batch.createTime,
      completedAt: batch.endTime,
      failedAt: batch.updateTime,
      expiredAt: null,
      errors: batch.error || null,
      provider: 'gemini',
      rawState: batch.state,
    };
  }

  const batch = await getOpenAI().batches.retrieve(batchId);
  const rc = batch.request_counts || {};
  console.log(`🔍 [pollBatchStatus] ${batchId}: ${batch.status} — completed: ${rc.completed||0}/${rc.total||0}, failed: ${rc.failed||0}`);
  return {
    id: batch.id,
    status: batch.status,
    requestCounts: batch.request_counts,
    outputFileId: batch.output_file_id,
    errorFileId: batch.error_file_id,
    createdAt: batch.created_at,
    completedAt: batch.completed_at,
    failedAt: batch.failed_at,
    expiredAt: batch.expired_at,
    errors: batch.errors,
    provider: 'openai',
  };
}

// ─── Download & Parse Results ──────────────────────────────────

/**
 * Download batch output JSONL and parse into results array.
 * Returns array of { customId, fileIndex, translated, tokensUsed, error }
 */
export async function downloadBatchResults(outputFileId, provider = null) {
  console.log(`📥 [downloadBatchResults] Downloading output file: ${outputFileId}`);
  const batchProvider = provider || inferProvider(outputFileId);
  const text = batchProvider === 'gemini'
    ? await downloadGeminiFileText(outputFileId)
    : await (await getOpenAI().files.content(outputFileId)).text();
  const lines = text.trim().split('\n');
  console.log(`📥 [downloadBatchResults] Downloaded ${lines.length} result lines (${text.length} bytes)`);
  const results = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const customId = obj.custom_id || obj.key;
      const fileIndex = parseInt(String(customId).split('::')[1], 10);

      if (batchProvider === 'gemini') {
        const translated = sanitizeTranslatedTemplate(
          obj.translated || obj.response?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || ''
        );
        const usage = obj.response?.usageMetadata || {};
        const tokensUsed = Number(usage.totalTokenCount || 0);
        results.push({
          customId,
          fileIndex,
          translated: translated || null,
          tokensUsed,
          error: translated ? null : (obj.error?.message || 'Empty translation result'),
        });
        continue;
      }

      if (obj.response?.status_code === 200) {
        const translated = sanitizeTranslatedTemplate(
          obj.response.body?.choices?.[0]?.message?.content || ''
        );
        results.push({
          customId,
          fileIndex,
          translated: translated || null,
          tokensUsed: obj.response.body?.usage?.total_tokens || 0,
          error: translated ? null : 'Empty translation result',
        });
      } else {
        results.push({
          customId,
          fileIndex,
          translated: null,
          tokensUsed: 0,
          error: obj.response?.body?.error?.message || `HTTP ${obj.response?.status_code}`,
        });
      }
    } catch (e) {
      console.error('Failed to parse batch result line:', e.message);
    }
  }

  const ok = results.filter(r => r.translated).length;
  const fail = results.filter(r => r.error).length;
  const totalTokens = results.reduce((s, r) => s + (r.tokensUsed || 0), 0);
  console.log(`📊 [downloadBatchResults] Parsed: ${ok} ok, ${fail} failed, ${totalTokens} total tokens`);
  return results;
}

/**
 * Download batch error file (if any) and parse into error array.
 */
export async function downloadBatchErrors(errorFileId, provider = null) {
  if (!errorFileId) return [];
  try {
    const batchProvider = provider || inferProvider(errorFileId);
    const text = batchProvider === 'gemini'
      ? await downloadGeminiFileText(errorFileId)
      : await (await getOpenAI().files.content(errorFileId)).text();
    return text.trim().split('\n').map(line => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch (e) {
    console.error('Failed to download error file:', e.message);
    return [];
  }
}

// ─── Validation ────────────────────────────────────────────────

/**
 * Validate that translated Blade template preserves critical structures.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateTranslation(original, translated, meta = '') {
  const errors = [];
  translated = sanitizeTranslatedTemplate(translated);

  if (!translated || translated.trim().length === 0) {
    console.warn(`⚠️ [validateTranslation] Empty translation ${meta}`);
    return { valid: false, errors: ['Empty translation'] };
  }

  // Length ratio check (translated should be 0.2x - 4.0x of original)
  const ratio = translated.length / original.length;
  if (ratio < 0.2 || ratio > 4.0) {
    errors.push(`Suspicious length ratio: ${ratio.toFixed(2)}x (original: ${original.length}, translated: ${translated.length})`);
  }

  // Check Blade directives are preserved
  const directives = ['@extends', '@section', '@endsection', '@yield', '@include',
    '@if', '@endif', '@else', '@elseif', '@foreach', '@endforeach',
    '@for', '@endfor', '@while', '@endwhile', '@switch', '@endswitch',
    '@php', '@endphp', '@push', '@endpush', '@stack', '@slot', '@endslot',
    '@component', '@endcomponent', '@props', '@aware'];

  for (const dir of directives) {
    const origCount = countOccurrences(original, dir);
    const transCount = countOccurrences(translated, dir);
    if (origCount > 0 && transCount !== origCount) {
      errors.push(`Directive ${dir}: expected ${origCount}, got ${transCount}`);
    }
  }

  // Check {{ }} and {!! !!} variable counts
  const origVars = (original.match(/\{\{[^}]+\}\}/g) || []).length;
  const transVars = (translated.match(/\{\{[^}]+\}\}/g) || []).length;
  if (origVars > 0 && Math.abs(origVars - transVars) > 1) {
    errors.push(`Variable {{ }}: expected ~${origVars}, got ${transVars}`);
  }

  const origRaw = (original.match(/\{!![^}]+!!\}/g) || []).length;
  const transRaw = (translated.match(/\{!![^}]+!!\}/g) || []).length;
  if (origRaw > 0 && transRaw !== origRaw) {
    errors.push(`Raw {!! !!}: expected ${origRaw}, got ${transRaw}`);
  }

  // Check HTML structure (opening/closing tag balance for key tags)
  const criticalTags = ['div', 'section', 'main', 'header', 'footer', 'nav', 'form'];
  for (const tag of criticalTags) {
    const origOpen = countRegex(original, new RegExp(`<${tag}[\\s>]`, 'gi'));
    const origClose = countRegex(original, new RegExp(`</${tag}>`, 'gi'));
    const transOpen = countRegex(translated, new RegExp(`<${tag}[\\s>]`, 'gi'));
    const transClose = countRegex(translated, new RegExp(`</${tag}>`, 'gi'));

    if (origOpen > 0 && transOpen !== origOpen) {
      errors.push(`<${tag}>: expected ${origOpen} opening, got ${transOpen}`);
    }
    if (origClose > 0 && transClose !== origClose) {
      errors.push(`</${tag}>: expected ${origClose} closing, got ${transClose}`);
    }
  }

  // Check that markdown wrapper hasn't been added (```html...```)
  if (/^```/.test(translated.trim())) {
    errors.push('Translation wrapped in markdown code block');
  }

  if (errors.length > 0) {
    console.warn(`⚠️ [validateTranslation] Failed ${meta}: ${errors.join('; ')}`);
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

function countOccurrences(str, substr) {
  let count = 0, pos = 0;
  while ((pos = str.indexOf(substr, pos)) !== -1) { count++; pos += substr.length; }
  return count;
}

function countRegex(str, regex) {
  return (str.match(regex) || []).length;
}

// ─── Cancel Batch ──────────────────────────────────────────────

export async function cancelBatch(batchId, providerOrOptions = null) {
  try {
    const provider = typeof providerOrOptions === 'string'
      ? providerOrOptions
      : providerOrOptions?.provider;

    const resolvedProvider = provider || inferProvider(batchId);

    if (resolvedProvider === 'gemini') {
      const batch = await getGemini().batches.cancel({ name: batchId });
      console.log(`🛑 Gemini batch ${batchId} cancelled`);
      return batch;
    }
    const batch = await getOpenAI().batches.cancel(batchId);
    console.log(`🛑 Batch ${batchId} cancelled`);
    return batch;
  } catch (e) {
    console.error(`Failed to cancel batch ${batchId}:`, e.message);
    throw e;
  }
}
