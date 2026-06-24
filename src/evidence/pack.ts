// Assemble an evidence pack (ZIP) from a set of evidence items. Reads each file's
// bytes and adds a manifest. Shared by the period evidence download and the audit-
// request pack. Files whose bytes can't be read are skipped but still listed in the
// manifest, so a gap is visible rather than silent.

import AdmZip from 'adm-zip';
import { readObject } from '../storage/objects';
import { evidenceManifestCsv, type EvidenceItem } from './evidence';

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_');

export async function buildEvidenceZipBuffer(items: EvidenceItem[], label: string): Promise<Buffer> {
  const zip = new AdmZip();
  const root = `evidence-${safe(label || 'all')}`;
  for (const it of items) {
    if (!it.storedPath) continue;
    try {
      const bytes = await readObject(it.storedPath);
      zip.addFile(`${root}/${safe(it.classification || 'OTHER')}/${safe(`${it.id}-${it.fileName}`)}`, bytes);
    } catch {
      /* unreadable bytes — still appears in the manifest below */
    }
  }
  zip.addFile(`${root}/manifest.csv`, Buffer.from(evidenceManifestCsv(items), 'utf8'));
  return zip.toBuffer();
}
