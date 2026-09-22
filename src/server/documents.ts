import {partText,PARTY_LABELS,type ContractPart,type ContractParty} from '../lib/contract-document';
import {documentBody,sha256 as bodyHash} from '../lib/skill-audit';
import {exportProblems} from '../lib/contract-library/playbooks';
import {
  AlignmentType,
  BorderStyle,
  TableLayoutType,
  ShadingType,
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

export const CONTRACT_WORD_PROFILE=Object.freeze({id:'cn-contract-v2',width:11906,height:16838,margin:1440,bodySize:24,line:360});
const BODY_WIDTH=CONTRACT_WORD_PROFILE.width-2*CONTRACT_WORD_PROFILE.margin;
function missingValue(value:string|undefined|null){return value?.trim()||'[待补充]';}
function textRun(text:string,options:{bold?:boolean;size?:number;font?:string}={}){
 return new TextRun({text,bold:options.bold,size:options.size??24,font:{ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:options.font||'宋体'},color:'000000',language:{value:'zh-CN'}});
}
function paragraph(text:string,options:{bold?:boolean;size?:number;indent?:boolean;keepNext?:boolean;after?:number}={}){
 return new Paragraph({children:[textRun(text,options)],alignment:AlignmentType.JUSTIFIED,
  indent:options.indent?{firstLine:480}:undefined,keepNext:options.keepNext,widowControl:true,
  spacing:{line:360,after:options.after??100}});
}
function paragraphLines(value:string){return value.split(/\r?\n/).map(line=>paragraph(line,{indent:!!line.trim()}));}
function dataTable(columns:string[],rows:string[][]){
 const weights=columns.map((_,i)=>Math.max(3,Math.min(24,Math.max(columns[i].length,...rows.map(r=>(r[i]||'').length)))));
 const total=weights.reduce((a,b)=>a+b,0),widths=weights.map(w=>Math.floor(BODY_WIDTH*w/total));widths[widths.length-1]+=BODY_WIDTH-widths.reduce((a,b)=>a+b,0);
 const row=(cells:string[],header=false)=>new TableRow({tableHeader:header?true:undefined,cantSplit:header||Math.max(...cells.map(c=>c.length))<600,
  children:cells.map((cell,i)=>new TableCell({width:{size:widths[i],type:WidthType.DXA},margins:{top:100,bottom:100,left:100,right:100},
   ...(header?{shading:{type:ShadingType.CLEAR,fill:'F2F2F2'}}:{}),children:cell.split(/\r?\n/).map(line=>new Paragraph({children:[textRun(line,{bold:header,size:24})],spacing:{line:300,after:0},widowControl:true}))}))});
 return new Table({width:{size:BODY_WIDTH,type:WidthType.DXA},layout:TableLayoutType.FIXED,columnWidths:widths,rows:[row(columns,true),...rows.map(r=>row(r))]});
}
function renderPart(part:ContractPart,numberingReference:string):Array<Paragraph|Table>{
 if(!part.blocks?.length)return paragraphLines(part.content);
 return part.blocks.flatMap((block):Array<Paragraph|Table>=>{
  if(block.kind==='table')return [dataTable(block.columns,block.rows),paragraph('',{after:100})];
  if(block.kind==='heading')return [new Paragraph({numbering:{reference:numberingReference,level:block.level-2},heading:block.level===2?HeadingLevel.HEADING_2:HeadingLevel.HEADING_3,children:[textRun(block.text,{bold:true})],keepNext:true,spacing:{line:360,before:160,after:80}})];
  if(block.kind==='list')return block.items.map((item,i)=>paragraph(`${i+1}. ${item}`));
  return paragraphLines(block.text);
 });
}
function partyLines(p:ContractParty){
 const lines=[`${p.role}：${p.name}`];
 for(const key of ['registrationId','address','legalRepresentative','authorizedRepresentative','contactName','phone','email'] as const)
  if(p[key])lines.push(`${PARTY_LABELS[key]}：${p[key]}`);
 if(p.details?.trim())lines.push(p.details.trim());
 return lines;
}
function signatureBlocks(parties:ContractParty[]){
 const rows:TableRow[]=[];
 for(let n=0;n<parties.length;n+=2){
  const cells=parties.slice(n,n+2).map(p=>{
   const label=p.signatureMethod==='signature_and_seal'?'签名并盖章':p.signatureMethod==='seal'?'盖章':p.signatureMethod==='signature'?'签名':p.subjectType==='individual'?(p.authorizedRepresentative?'代理人签名':'本人签名'):'签名／盖章';
   const lines=[`${p.role}：${p.name}`,...(p.legalRepresentative?[`法定代表人：${p.legalRepresentative}`]:[]),...(p.authorizedRepresentative?[`授权签署人：${p.authorizedRepresentative}`]:[]),`${label}：`];
   return new TableCell({width:{size:Math.floor(BODY_WIDTH/2),type:WidthType.DXA},margins:{top:120,bottom:240,left:0,right:200},children:[
    ...lines.map((line,i)=>paragraph(line,{bold:i===0,keepNext:true,after:120})),
    new Paragraph({children:[textRun('')],keepNext:true,spacing:{after:p.subjectType==='individual'?480:960}}),
    paragraph('签署日期：______年____月____日',{after:120}),
   ]});
  });
  if(cells.length===1)cells.push(new TableCell({children:[paragraph('')]}));
  rows.push(new TableRow({cantSplit:true,children:cells}));
 }
 const border={style:BorderStyle.NONE,size:0,color:'FFFFFF'};
 return new Table({width:{size:BODY_WIDTH,type:WidthType.DXA},layout:TableLayoutType.FIXED,columnWidths:[Math.floor(BODY_WIDTH/2),Math.ceil(BODY_WIDTH/2)],borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},rows});
}

/** Business text is checked before rendering; signing blanks are deliberate execution fields. */
export async function renderContract(content:ContractContent,options:{template?:boolean}={}):Promise<Buffer>{
 if(!options.template){const problems=exportProblems(content);if(problems.length)throw new Error('EXPORT_NOT_READY: '+problems.join('；'));}
 if(!options.template&&content.skillAudit){const digest=await bodyHash(documentBody(content));if(content.skillAudit.contentSha256!==digest||content.skillAudit.consistency&&content.skillAudit.consistency.contentSha256!==digest)throw new Error('EXPORT_NOT_READY: 正文与规则应用记录不一致，请重新起草核对');}
 const title=missingValue(content.title),parties=content.parties;
 const children:Array<Paragraph|Table>=[new Paragraph({heading:HeadingLevel.TITLE,alignment:AlignmentType.CENTER,keepNext:true,spacing:{after:360},children:[textRun(title,{size:34,bold:true,font:'黑体'})]})];
 for(const p of parties)partyLines(p).forEach((line,i,lines)=>children.push(paragraph(line,{bold:i===0,keepNext:i<lines.length-1,after:120})));
 for(const [index,part] of content.sections.entries()){children.push(new Paragraph({heading:HeadingLevel.HEADING_1,numbering:{reference:'contractSections',level:0},keepNext:true,spacing:{before:240,after:120,line:360},children:[textRun(part.title,{bold:true})]}));children.push(...renderPart(part,'section-'+index));}
 children.push(new Paragraph({pageBreakBefore:true,keepNext:true,spacing:{after:240},children:[textRun(`《${title}》签署页`,{bold:true,size:28})]}));
 if(content.signing.trim())children.push(...paragraphLines(content.signing));
 children.push(signatureBlocks(parties));
 (content.attachments||[]).forEach((part,index)=>{
  children.push(new Paragraph({pageBreakBefore:true,heading:HeadingLevel.HEADING_1,keepNext:true,spacing:{after:240},children:[textRun(`附件${index+1}：${part.title}`,{bold:true,size:28})]}));children.push(...renderPart(part,'attachment-'+index));
  if(part.signatureRequired){children.push(paragraph('附件确认',{bold:true,keepNext:true}));children.push(signatureBlocks(parties));}
 });
 const font={ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'宋体'};
 const headingStyle={run:{font,size:24,bold:true,color:'000000'},paragraph:{keepNext:true,spacing:{line:360,before:240,after:120}}};
 const nestedNumbering=[...content.sections.map((_,i)=>({reference:'section-'+i,prefix:String(i+1)})),...(content.attachments||[]).map((_,i)=>({reference:'attachment-'+i,prefix:'附件'+(i+1)}))].map(({reference,prefix})=>({reference,levels:[0,1].map(level=>({level,format:LevelFormat.DECIMAL,text:prefix+(level===0?'.%1':'.%1.%2'),alignment:AlignmentType.START,style:{run:{font,size:24},paragraph:{indent:{left:0,hanging:0}}}}))}));
 const document=new Document({title,subject:'合同',creator:'',description:'',features:{updateFields:true},
  numbering:{config:[...nestedNumbering,{reference:'contractSections',levels:[{level:0,format:LevelFormat.DECIMAL,text:'第%1条',alignment:AlignmentType.START,style:{run:{font,size:24},paragraph:{indent:{left:0,hanging:0}}}}]}]},
  styles:{default:{document:{run:{font,size:24,color:'000000'},paragraph:{spacing:{line:360,after:100}}},title:{run:{font,size:34,color:'000000',bold:true}},heading1:headingStyle,heading2:headingStyle,heading3:headingStyle}},
  sections:[{properties:{page:{size:{width:CONTRACT_WORD_PROFILE.width,height:CONTRACT_WORD_PROFILE.height},margin:{top:1440,bottom:1440,left:1440,right:1440,header:720,footer:720}}},
   headers:{default:new Header({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[textRun(title,{size:18})]})]})},
   footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[textRun('第 ',{size:18}),new TextRun({children:[PageNumber.CURRENT],size:18,font}),textRun(' 页 / 共 ',{size:18}),new TextRun({children:[PageNumber.TOTAL_PAGES],size:18,font}),textRun(' 页',{size:18})]})]})},children}]
 });
 const bytes=Buffer.from(await Packer.toBuffer(document));validateDocxBuffer(bytes);assertContractLayout(bytes);return bytes;
}
/** Check the actual OOXML rather than trusting the selected profile. Visual QA remains separate. */
export function assertContractLayout(bytes:Buffer){
 const files=unzipSync(bytes),xml=Buffer.from(files['word/document.xml']).toString('utf8'),footer=Buffer.from(files['word/footer1.xml']).toString('utf8');
 if(!/w:w="11906"/.test(xml)||!/w:h="16838"/.test(xml)||!/NUMPAGES/.test(footer)||!/PAGE/.test(footer)||!xml.includes('签署页'))throw new Error('DOCX_LAYOUT_INVALID: 页面或签署结构不完整');
 if(!/w:eastAsia="宋体"/.test(xml)||!/w:sz w:val="24"/.test(xml)||!/w:line="360"/.test(xml))throw new Error('DOCX_LAYOUT_INVALID: 中文排版配置未落入文件');
}

export { DOCX_CONTENT_TYPE };
export { sha256Hex };
// Kept as a compatibility re-export for the existing contract service import.
// New code should import storage from ./storage so document generation and
// object storage remain separate concerns.
export { storage } from './storage';
