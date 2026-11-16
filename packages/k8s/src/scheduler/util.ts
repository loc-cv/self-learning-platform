// Small accessors shared by the scheduler's files.

export { creationMicros, labelsOf, metaOf, nameOf, namespaceOf, specOf, statusOf, uidOf } from '../controllers/objects.ts';
import type { Json } from '../apimachinery/json.ts';

export const str = (v: Json | undefined): string => (typeof v === 'string' ? v : '');
