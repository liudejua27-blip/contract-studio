import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { unzipSync } from 'fflate';
import { sha256Hex } from './storage';
import type { ContractContent } from '../lib/types';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;

export const DEFAULT_DOCX_LIMITS = Object.freeze({
  maxCompressedBytes: 25 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxEntryBytes: 20 * 1024 * 1024,
  maxEntries: 512,
  maxCompressionRatio: 250,
});

export interface DocxValidationLimits {
  maxCompressedBytes?: number;
  maxUncompressedBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  maxCompressionRatio?: number;
}

export interface DocxPackageEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  flags: number;
  localHeaderOffset: number;
}

export interface ValidatedDocx {
  bytes: Buffer;
  sha256: string;
  entries: readonly DocxPackageEntry[];
  uncompressedBytes: number;
}

export class DocxValidationError extends Error {
  readonly code = 'INVALID_DOCX';

  constructor(message: string) {
    super(message);
    this.name = 'DocxValidationError';
  }
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)
  ) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (offset >= 0 && u32(bytes, offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new DocxValidationError('DOCX ZIP end-of-central-directory record is missing');
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (flags & 0x800) throw new DocxValidationError('DOCX ZIP filename is not valid UTF-8');
    // A DOCX written by Word uses UTF-8. For old packages without the UTF-8
    // flag, decoding as UTF-8 still gives us a safe, deterministic name.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function assertSafeZipName(name: string): void {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new DocxValidationError(`unsafe DOCX ZIP filename: ${name || '<empty>'}`);
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new DocxValidationError(`path traversal in DOCX ZIP filename: ${name}`);
  }
  if (/^[\u0000-\u001f\u007f]/.test(name) || name.length > 512) {
    throw new DocxValidationError('DOCX ZIP filename contains a control character or is too long');
  }
}

function parseCentralDirectory(bytes: Uint8Array, limits: Required<DocxValidationLimits>): DocxPackageEntry[] {
  if (bytes.length < 22 || u32(bytes, 0) !== ZIP_LOCAL_FILE_HEADER) {
    throw new DocxValidationError('DOCX must be a ZIP package');
  }
  const eocd = findEndOfCentralDirectory(bytes);
  const diskNumber = u16(bytes, eocd + 4);
  const centralDirectoryDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const entries = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entries) {
    throw new DocxValidationError('multi-disk DOCX ZIP packages are not supported');
  }
  if (entries === 0xffff || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL) {
    throw new DocxValidationError('ZIP64 DOCX packages are not accepted');
  }
  if (entries === 0 || entries > limits.maxEntries || centralOffset + centralSize > bytes.length) {
    throw new DocxValidationError('DOCX ZIP central directory is invalid or too large');
  }

  const result: DocxPackageEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > bytes.length || u32(bytes, cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new DocxValidationError('DOCX ZIP central directory entry is malformed');
    }
    const flags = u16(bytes, cursor + 8);
    const compressionMethod = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localHeaderOffset = u32(bytes, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length || uncompressedSize === ZIP64_SENTINEL || compressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new DocxValidationError('ZIP64 or truncated DOCX ZIP entry');
    }
    const name = decodeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    assertSafeZipName(name);
    if (names.has(name)) throw new DocxValidationError(`duplicate DOCX ZIP filename: ${name}`);
    names.add(name);
    if ((flags & 0x1) !== 0) throw new DocxValidationError('encrypted DOCX ZIP entries are not accepted');
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new DocxValidationError(`unsupported DOCX ZIP compression method: ${compressionMethod}`);
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new DocxValidationError(`DOCX ZIP entry exceeds the per-entry size limit: ${name}`);
    }
    if (compressedSize === 0 && uncompressedSize > 0) {
      throw new DocxValidationError(`DOCX ZIP entry has an invalid zero compressed size: ${name}`);
    }
    if (uncompressedSize > Math.max(1, compressedSize) * limits.maxCompressionRatio) {
      throw new DocxValidationError(`DOCX ZIP compression ratio is unsafe: ${name}`);
    }
    if (localHeaderOffset + 30 > bytes.length || u32(bytes, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw new DocxValidationError(`DOCX ZIP local header is missing: ${name}`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) {
      throw new DocxValidationError('DOCX ZIP uncompressed size exceeds the total limit');
    }
    result.push({ name, compressedSize, uncompressedSize, compressionMethod, flags, localHeaderOffset });
    cursor = end;
  }
  if (cursor > centralOffset + centralSize) throw new DocxValidationError('DOCX ZIP central directory overrun');
  return result;
}

function mergedLimits(options: DocxValidationLimits = {}): Required<DocxValidationLimits> {
  const merged = { ...DEFAULT_DOCX_LIMITS, ...options };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new DocxValidationError(`invalid DOCX validation limit: ${key}`);
  }
  return merged;
}

/**
 * Validate an uploaded DOCX as a bounded, real OOXML ZIP package. The central
 * directory is checked before fflate inflates anything, which keeps declared
 * ZIP-bomb sizes from causing an unbounded allocation.
 */
export function validateDocxBuffer(input: Buffer | Uint8Array, options: DocxValidationLimits = {}): ValidatedDocx {
  const bytes = asBuffer(input);
  const limits = mergedLimits(options);
  if (bytes.length > limits.maxCompressedBytes) throw new DocxValidationError('DOCX upload exceeds the compressed size limit');
  const entries = parseCentralDirectory(bytes, limits);
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes) as Record<string, Uint8Array>;
  } catch (error) {
    throw new DocxValidationError(`DOCX ZIP could not be inflated: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const required = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
  for (const name of required) {
    if (!unzipped[name]) throw new DocxValidationError(`DOCX package is missing ${name}`);
  }
  const declaredByName = new Map(entries.map((entry) => [entry.name, entry]));
  let actualUncompressed = 0;
  for (const [name, value] of Object.entries(unzipped)) {
    const entry = declaredByName.get(name);
    if (!entry) throw new DocxValidationError(`DOCX ZIP returned an undeclared entry: ${name}`);
    if (value.length !== entry.uncompressedSize) throw new DocxValidationError(`DOCX ZIP size mismatch: ${name}`);
    actualUncompressed += value.length;
    if (actualUncompressed > limits.maxUncompressedBytes) throw new DocxValidationError('DOCX inflated data exceeds the total limit');
    if (name.toLowerCase().endsWith('vbaproject.bin')) throw new DocxValidationError('macro-enabled DOCX files are not accepted');
  }
  const documentXml = Buffer.from(unzipped['word/document.xml']);
  if (!/<w:document(?:\s|>)/.test(documentXml.toString('utf8')) || !/<w:body(?:\s|>)/.test(documentXml.toString('utf8'))) {
    throw new DocxValidationError('word/document.xml is not a WordprocessingML document');
  }
  return { bytes, sha256: sha256Hex(bytes), entries, uncompressedBytes: actualUncompressed };
}

export function isDocxBuffer(input: Buffer | Uint8Array, options: DocxValidationLimits = {}): boolean {
  try {
    validateDocxBuffer(input, options);
    return true;
  } catch {
    return false;
  }
}

// Compatibility alias for the backend upload path. It returns the validated
// bytes and digest so callers can persist the exact package they inspected.
export const validateDocx = validateDocxBuffer;

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const number = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isSafeInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

/**
 * Extract the visible text from a DOCX for an AI context preview. This is a
 * deliberately small OOXML reader: it only consumes w:t and structural
 * paragraph/table markers, rejects DTD/entity declarations, and never follows
 * external relationships or URLs. Callers should treat the result as source
 * context, not as a trusted legal conclusion.
 */
export function extractDocxText(
  input: Buffer | Uint8Array,
  options: { maxXmlBytes?: number; maxTextChars?: number } = {},
): string {
  const validated = validateDocxBuffer(input);
  const maxXmlBytes = options.maxXmlBytes ?? 10 * 1024 * 1024;
  const maxTextChars = options.maxTextChars ?? 250_000;
  const files = unzipSync(validated.bytes) as Record<string, Uint8Array>;
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes || xmlBytes.byteLength > maxXmlBytes) throw new DocxValidationError('DOCX document XML exceeds the text extraction limit');
  const xml = Buffer.from(xmlBytes).toString('utf8');
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) throw new DocxValidationError('DOCX document XML contains a DTD or external entity declaration');

  const pieces: string[] = [];
  const tokenPattern = /<w:p(?:\s[^>]*)?>|<\/w:p\s*>|<w:tr(?:\s[^>]*)?>|<\/w:tr\s*>|<w:tc(?:\s[^>]*)?>|<\/w:tc\s*>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>|<w:cr(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(xml))) {
    const token = match[0];
    if (/^<w:t\b/i.test(token)) {
      pieces.push(decodeXmlText(match[1] ?? ''));
    } else if (/^<w:tab\b/i.test(token)) {
      pieces.push('\t');
    } else if (/^<w:(?:br|cr)\b/i.test(token)) {
      pieces.push('\n');
    } else if (/^<\/w:(?:p|tr)\b/i.test(token)) {
      pieces.push('\n');
    } else if (/^<\/w:tc\b/i.test(token)) {
      pieces.push('\t');
    }
    if (pieces.join('').length > maxTextChars) throw new DocxValidationError('DOCX extracted text exceeds the context limit');
  }
  return pieces.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\t ]+$/g, '')
    .trim();
}

function missingValue(value: string | undefined | null): string {
  return value && value.trim() ? value.trim() : '[待补充]';
}

function textRun(text: string, options: { bold?: boolean; size?: number; font?: string; color?: string } = {}): TextRun {
  return new TextRun({
    text,
    bold: options.bold,
    size: options.size ?? 22,
    font: options.font ?? '宋体',
    color: options.color ?? '000000',
    language: { value: 'zh-CN', eastAsia: '宋体' },
  });
}

function paragraphLines(value: string | undefined | null, options: { indent?: number; spacingAfter?: number } = {}): Paragraph[] {
  const text = missingValue(value);
  return text.split(/\r?\n/).map((line) => new Paragraph({
    children: [textRun(line || '[待补充]')],
    indent: options.indent ? { firstLine: options.indent } : undefined,
    spacing: { after: options.spacingAfter ?? 140, line: 320 },
  }));
}

function contractPartyRows(parties: ContractContent['parties']): TableRow[] {
  const rows = parties.length > 0 ? parties : [{ role: '甲方', name: '', details: '' }, { role: '乙方', name: '', details: '' }];
  return rows.map((party) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ children: [textRun(missingValue(party.role), { bold: true })] })] }),
      new TableCell({ children: [new Paragraph({ children: [textRun(missingValue(party.name))] })] }),
      new TableCell({ children: [new Paragraph({ children: [textRun(missingValue(party.details))] })] }),
    ],
  }));
}

function signingRows(parties: ContractContent['parties']): TableRow[] {
  const rows = parties.length > 0 ? parties : [{ role: '甲方', name: '' }, { role: '乙方', name: '' }];
  return rows.map((party) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ children: [textRun(missingValue(party.role), { bold: true })] })] }),
      new TableCell({ children: [new Paragraph({ children: [textRun(`名称：${missingValue(party.name)}`)] }), new Paragraph({ children: [textRun('盖章：________________') ] })] }),
      new TableCell({ children: [new Paragraph({ children: [textRun('签署日期：____年__月__日')] })] }),
    ],
  }));
}

/**
 * Render a structured contract into a deterministic DOCX. The output is
 * intentionally conservative: readable Chinese typography, explicit missing
 * markers, real section numbering, a signing page, and Word page fields.
 */
export async function renderContract(content: ContractContent): Promise<Buffer> {
  const title = missingValue(content?.title);
  const parties = Array.isArray(content?.parties) ? content.parties : [];
  const sections = Array.isArray(content?.sections) ? content.sections : [];
  const missing = Array.isArray(content?.missing) ? content.missing.filter((item) => typeof item === 'string' && item.trim()) : [];

  const header = new Header({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [textRun(`合同工作室 · ${title}`, { size: 18, font: '宋体' })],
    })],
  });
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        textRun('第 ', { size: 18 }),
        new TextRun({ children: [PageNumber.CURRENT], size: 18, font: '宋体', color: '000000' }),
        textRun(' 页', { size: 18 }),
      ],
    })],
  });

  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 },
      children: [textRun(title, { bold: true, size: 34, font: '黑体' })],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 180, after: 140 },
      children: [textRun('合同主体', { bold: true, size: 26, font: '黑体' })],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [textRun('主体', { bold: true })] })] }),
            new TableCell({ children: [new Paragraph({ children: [textRun('名称', { bold: true })] })] }),
            new TableCell({ children: [new Paragraph({ children: [textRun('信息', { bold: true })] })] }),
          ],
        }),
        ...contractPartyRows(parties),
      ],
    }),
  ];

  sections.forEach((section) => {
    children.push(new Paragraph({
      numbering: { reference: 'contractSections', level: 0 },
      keepNext: true,
      spacing: { before: 280, after: 120 },
      children: [textRun(missingValue(section?.title), { bold: true, size: 25, font: '黑体' })],
    }));
    children.push(...paragraphLines(section?.content));
  });

  if (missing.length > 0) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 280, after: 140 },
      children: [textRun('待补充事项', { bold: true, size: 26, font: '黑体' })],
    }));
    missing.forEach((item) => children.push(new Paragraph({
      bullet: { level: 0 },
      spacing: { after: 120, line: 320 },
      children: [textRun(missingValue(item))],
    })));
  }

  children.push(new Paragraph({
    pageBreakBefore: true,
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 220 },
    children: [textRun('签署页', { bold: true, size: 28, font: '黑体' })],
  }));
  children.push(...paragraphLines(content?.signing, { spacingAfter: 180 }));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: signingRows(parties),
  }));

  const document = new Document({
    title,
    subject: '中文合同草稿',
    creator: '合同工作室',
    description: '由合同工作室生成的合同草稿，签署前请确认待补充事项。',
    features: { updateFields: true },
    numbering: {
      config: [{
        reference: 'contractSections',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '第%1条', alignment: AlignmentType.START }],
      }],
    },
    styles: {
      default: {
        document: {
          run: { font: '宋体', size: 22, color: '000000' },
          paragraph: { spacing: { line: 320, after: 140 } },
        },
      },
    },
    sections: [{
      headers: { default: header },
      footers: { default: footer },
      properties: {
        page: {
          // Letter is the document skill's portable default; the body remains
          // comfortable for Chinese text and can be changed by Word later.
          size: { width: 12240, height: 15840 },
          margin: { top: 1200, right: 1200, bottom: 1200, left: 1200, header: 560, footer: 560 },
        },
      },
      children,
    }],
  });

  const bytes = Buffer.from(await Packer.toBuffer(document));
  // Render-time self-check catches programming errors before the caller stores
  // a file that the browser or OnlyOffice cannot open.
  validateDocxBuffer(bytes);
  return bytes;
}

export { DOCX_CONTENT_TYPE };
export { sha256Hex };
// Kept as a compatibility re-export for the existing contract service import.
// New code should import storage from ./storage so document generation and
// object storage remain separate concerns.
export { storage } from './storage';
