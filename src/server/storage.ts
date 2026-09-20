import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

export interface StorageAdapter {
  put(fileKey: string, bytes: Buffer, contentType?: string): Promise<void>;
  get(fileKey: string): Promise<Buffer | null>;
}

export interface FileSystemStorageOptions {
  rootDir?: string;
}

export interface S3StorageOptions {
  bucket: string;
  prefix?: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}

export interface CreateStorageOptions {
  backend?: 'filesystem' | 's3';
  rootDir?: string;
  bucket?: string;
  prefix?: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
  /** Only useful for an explicitly isolated test/development store. */
  allowFilesystemInProduction?: boolean;
}

export class StorageKeyError extends Error {
  readonly code = 'INVALID_STORAGE_KEY';

  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

export class StorageConfigurationError extends Error {
  readonly code = 'STORAGE_CONFIGURATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigurationError';
  }
}

/**
 * Return a deterministic hash for content that is about to be persisted.
 * The hash is deliberately computed by the application so it is also stored
 * beside the version record and can be compared after an OnlyOffice callback.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Normalise an object key without ever allowing it to escape its private
 * storage namespace. Backslashes and dot segments are rejected rather than
 * normalised, because accepting them makes the result platform-dependent.
 */
export function normalizeStorageKey(fileKey: string): string {
  if (typeof fileKey !== 'string' || fileKey.length === 0) {
    throw new StorageKeyError('fileKey must be a non-empty string');
  }
  if (fileKey.length > 512 || fileKey.includes('\0')) {
    throw new StorageKeyError('fileKey is too long or contains a NUL byte');
  }
  if (fileKey.includes('\\') || fileKey.startsWith('/') || isAbsolute(fileKey)) {
    throw new StorageKeyError('fileKey must be a relative POSIX path');
  }
  if (/^[A-Za-z]:/.test(fileKey)) {
    throw new StorageKeyError('drive-qualified fileKey is not allowed');
  }

  const segments = fileKey.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new StorageKeyError('fileKey contains an empty or traversal segment');
  }
  if (segments.some((segment) => /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new StorageKeyError('fileKey contains a control character');
  }

  const normalized = posix.normalize(fileKey);
  if (normalized !== fileKey || normalized === '.' || normalized.startsWith('../')) {
    throw new StorageKeyError('fileKey is not canonical');
  }
  return normalized;
}

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return '';
  const cleaned = prefix.replace(/\/+$/, '').replace(/^\/+/, '');
  return normalizeStorageKey(cleaned);
}

async function assertNoSymlinkPath(rootDir: string, targetDir: string): Promise<void> {
  const root = resolve(rootDir);
  const target = resolve(targetDir);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new StorageKeyError('resolved storage path escaped the private root');
  }

  try {
    const rootEntry = await lstat(root);
    if (rootEntry.isSymbolicLink()) {
      throw new StorageKeyError('symbolic links are not allowed in private storage paths');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new StorageKeyError('symbolic links are not allowed in private storage paths');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

function isMissingObjectError(error: unknown): boolean {
  const maybe = error as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  return (
    maybe?.name === 'NoSuchKey' ||
    maybe?.name === 'NotFound' ||
    maybe?.Code === 'NoSuchKey' ||
    maybe?.$metadata?.httpStatusCode === 404
  );
}

export class PrivateFileSystemStorage implements StorageAdapter {
  readonly rootDir: string;

  constructor(options: FileSystemStorageOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? process.env.CONTRACT_PRIVATE_STORAGE_DIR ?? join(process.cwd(), '.data', 'private-files'));
  }

  private pathFor(fileKey: string): string {
    const key = normalizeStorageKey(fileKey);
    const target = resolve(this.rootDir, ...key.split('/'));
    const rel = relative(this.rootDir, target);
    if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
      throw new StorageKeyError('resolved storage path escaped the private root');
    }
    return target;
  }

  async put(fileKey: string, bytes: Buffer, _contentType?: string): Promise<void> {
    if (!Buffer.isBuffer(bytes)) {
      throw new TypeError('storage.put expects a Buffer');
    }
    const target = this.pathFor(fileKey);
    const targetDir = dirname(target);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await assertNoSymlinkPath(this.rootDir, targetDir);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });

    // Write in the same directory and rename atomically. This avoids readers
    // observing a partially written DOCX when a callback is retried.
    const tempName = `.${target.split(sep).pop() ?? 'object'}.${process.pid}.${randomUUID()}.tmp`;
    const tempPath = join(targetDir, tempName);
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tempPath, target);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(fileKey: string): Promise<Buffer | null> {
    const target = this.pathFor(fileKey);
    await assertNoSymlinkPath(this.rootDir, dirname(target));
    try {
      const entry = await lstat(target);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new StorageKeyError('private object is not a regular file');
      }
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export class S3PrivateStorage implements StorageAdapter {
  readonly bucket: string;
  readonly prefix: string;
  readonly client: S3Client;

  constructor(options: S3StorageOptions) {
    if (!options.bucket || /[\u0000\r\n]/.test(options.bucket)) {
      throw new StorageConfigurationError('S3 bucket is required');
    }
    this.bucket = options.bucket;
    this.prefix = normalizePrefix(options.prefix);
    this.client = options.client ?? new S3Client(options.clientConfig ?? {
      region: process.env.S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    });
  }

  private keyFor(fileKey: string): string {
    const key = normalizeStorageKey(fileKey);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(fileKey: string, bytes: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('storage.put expects a Buffer');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(fileKey),
      Body: bytes,
      ContentType: contentType,
      Metadata: { sha256: sha256Hex(bytes) },
      ServerSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION as 'AES256' | 'aws:kms' | undefined,
    }));
  }

  async get(fileKey: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.keyFor(fileKey),
      }));
      if (!result.Body) return null;
      const body = result.Body as unknown as {
        transformToByteArray?: () => Promise<Uint8Array>;
        [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | Buffer>;
      };
      if (body.transformToByteArray) return Buffer.from(await body.transformToByteArray());
      if (body[Symbol.asyncIterator]) {
        const chunks: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Uint8Array | Buffer>) {
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      }
      throw new StorageConfigurationError('S3 response body is not readable');
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }
}

function envS3Config(options: CreateStorageOptions): S3StorageOptions | null {
  const bucket = options.bucket ?? process.env.S3_BUCKET;
  if (!bucket) return null;
  return {
    bucket,
    prefix: options.prefix ?? process.env.S3_PREFIX,
    client: options.client,
    clientConfig: options.clientConfig,
  };
}

/**
 * Build a private storage adapter. Filesystem storage is intentionally a
 * development/test fallback; production must set S3_BUCKET or explicitly
 * choose another private adapter at the integration boundary.
 */
export function createStorage(options: CreateStorageOptions = {}): StorageAdapter {
  const requested = options.backend ?? (envS3Config(options) ? 's3' : 'filesystem');
  if (requested === 's3') {
    const s3 = envS3Config(options);
    if (!s3) throw new StorageConfigurationError('S3 storage requires S3_BUCKET');
    return new S3PrivateStorage(s3);
  }
  if (process.env.NODE_ENV === 'production' && !options.allowFilesystemInProduction) {
    throw new StorageConfigurationError('private filesystem storage is only a development fallback; configure S3 in production');
  }
  return new PrivateFileSystemStorage({ rootDir: options.rootDir });
}

export const storage: StorageAdapter = createStorage();
