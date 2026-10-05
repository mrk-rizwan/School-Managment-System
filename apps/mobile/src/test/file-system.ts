// expo-file-system's object API (File, Directory, Paths) over an in-memory map, for Jest
// (slice-16 §15.1). Paths and sizes behave as on the device closely enough for the photo lane,
// the wipe and the PDF download: a file exists until deleted, a directory lists its direct files.

const files = new Map<string, number>();
const directories = new Set<string>();
const downloads: { url: string; headers: Record<string, string>; to: string }[] = [];
let downloadReply: { status: number } | 'network' = { status: 200 };

export const DOCUMENT = 'file:///data/user/0/pk.asms.app.dev/files/';
export const CACHE = 'file:///data/user/0/pk.asms.app.dev/cache/';

const join = (...parts: string[]) =>
  parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .join('/');

type Part = string | File | Directory;
const uriOf = (parts: Part[]) => join(...parts.map((p) => (typeof p === 'string' ? p : p.uri)));

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

/**
 * As on the device, a File is a Blob (expo-file-system 57: `class File ... implements Blob`): its
 * name is the last path segment, its type comes from the extension, and its bytes are read when
 * it is sent as a multipart part (here: `size` zero bytes). It extends Node's File so the test
 * runtime's FormData keeps it as a file part with its filename and type.
 */
export class File extends globalThis.File {
  readonly uri: string;
  constructor(...parts: Part[]) {
    const uri = uriOf(parts);
    const name = nameOf(uri);
    super([], name, { type: TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? '' });
    this.uri = uri;
  }
  override get name(): string {
    return nameOf(this.uri);
  }
  override bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return Promise.resolve(new Uint8Array(this.size));
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(this.size));
  }
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(this.size);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  get exists(): boolean {
    return files.has(this.uri);
  }
  override get size(): number {
    return files.get(this.uri) ?? 0;
  }
  create(): void {
    files.set(this.uri, 0);
  }
  write(content: string): void {
    files.set(this.uri, content.length);
  }
  delete(): void {
    if (!files.delete(this.uri)) throw new Error(`File ${this.uri} does not exist`);
  }
  copySync(target: File): void {
    if (!files.has(this.uri)) throw new Error(`File ${this.uri} does not exist`);
    files.set(target.uri, files.get(this.uri)!);
  }
  static async downloadFileAsync(
    url: string,
    destination: File,
    options: { headers?: Record<string, string> } = {},
  ): Promise<File> {
    downloads.push({ url, headers: options.headers ?? {}, to: destination.uri });
    if (downloadReply === 'network') throw new Error('Network request failed');
    if (downloadReply.status >= 400) throw new Error(`Download failed: ${downloadReply.status}`);
    files.set(destination.uri, 2048);
    return destination;
  }
}

export class Directory {
  readonly uri: string;
  constructor(...parts: Part[]) {
    this.uri = uriOf(parts);
  }
  get exists(): boolean {
    return directories.has(this.uri) || [...files.keys()].some((f) => f.startsWith(`${this.uri}/`));
  }
  create(): void {
    directories.add(this.uri);
  }
  delete(): void {
    directories.delete(this.uri);
    for (const file of [...files.keys()]) if (file.startsWith(`${this.uri}/`)) files.delete(file);
  }
  list(): File[] {
    return [...files.keys()]
      .filter((f) => f.startsWith(`${this.uri}/`) && !f.slice(this.uri.length + 1).includes('/'))
      .map((f) => new File(f));
  }
}

export const Paths = {
  get document() {
    return new Directory(DOCUMENT);
  },
  get cache() {
    return new Directory(CACHE);
  },
};

// --- Test controls ---------------------------------------------------------------------------

/** A file "on the phone" (a picker's output, a stored photo). */
export function putFile(uri: string, size = 400_000): void {
  files.set(uri, size);
}

export const fileExists = (uri: string): boolean => files.has(uri);

/** Every file whose URI starts with `prefix`. */
export const filesUnder = (prefix: string): string[] =>
  [...files.keys()].filter((f) => f.startsWith(prefix)).sort();

export const downloadCalls = () => [...downloads];

export function replyToDownloads(reply: { status: number } | 'network'): void {
  downloadReply = reply;
}

export function resetFileSystem(): void {
  files.clear();
  directories.clear();
  downloads.length = 0;
  downloadReply = { status: 200 };
}
