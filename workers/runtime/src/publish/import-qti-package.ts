import { publishQtiPackage } from "./qti-package-publisher";
import type { PublishResult } from "./qti-publication-plan";
import {
  CloudflareQtiPublicationObjectStore,
  CloudflareQtiPublicationRepository,
} from "./qti-publication-store";

interface ImportQtiPackageOptions {
  readonly tenantId: string;
  readonly assessmentSlug: string;
  readonly packageName: string;
  readonly packageBytes: Uint8Array;
  readonly db: D1Database;
  readonly bucket: R2Bucket;
}

/** Cloudflare composition façade for the QTI package publication service. */
export async function importQtiPackage(options: ImportQtiPackageOptions): Promise<PublishResult> {
  return publishQtiPackage(options, {
    repository: new CloudflareQtiPublicationRepository(options.db),
    objectStore: new CloudflareQtiPublicationObjectStore(options.bucket),
    now: () => new Date(),
    generateId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
  });
}

export { QtiPublicationStorageError } from "./qti-package-publisher";
export type { PublishResult } from "./qti-publication-plan";
