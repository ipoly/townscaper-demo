// All building styles by name; the first is the default.

import european from './european.js';
import chinese from './chinese.js';
import { PALETTE_SIZE } from '../constants.js';

export const STYLES = { european, chinese };
export const DEFAULT_STYLE = 'european';

for (const kit of Object.values(STYLES)) {
  if (kit.walls.length !== PALETTE_SIZE || kit.roofs.length !== PALETTE_SIZE) throw new Error(`Style ${kit.name} needs ${PALETTE_SIZE} color pairs`);
}
