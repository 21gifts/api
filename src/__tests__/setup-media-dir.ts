import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const raw = process.env['MEDIA_DIR'];
if (raw === undefined || raw.trim() === '') {
  process.env['MEDIA_DIR'] = mkdtempSync(join(tmpdir(), '21gifts-media-'));
}
