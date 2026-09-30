// Landmarks crowning a building: the cupola or clock tower of a big roof, the lighthouse lantern.

import { WINDOW, WHITE, COPPER, GOLD, SLATE, LH_RED, LAMP } from '../constants.js';
import { ring } from '../emitter.js';

// ctx: the build context (emitter tools, town, verts, units, infoOf) plus the parts made before
export function landmarkParts(ctx) {
  const { E, tri, blob, box, prism, cone, infoOf } = ctx;

  // Rooftop landmark for big buildings, standing on the roof peak at c2
  const landmark = (type, c2, y, wallColor, m) => {
    if (type === 'cupola') {
      prism(c2, 0.26, y - 0.15, y + 0.3, 8, WHITE, m);
      for (const p of ring(c2, 0.265, 8, Math.PI / 8)) box(p, y + 0.02, y + 0.26, 0.035, [1, 0], WINDOW, m);
      blob([c2[0], y + 0.3, c2[1]], 0.27, 0.85, COPPER, m);
      prism(c2, 0.025, y + 0.5, y + 0.72, 4, GOLD, m);
    } else {
      box(c2, y - 0.15, y + 0.85, 0.17, [1, 0], wallColor, m);
      // Clock face on each side: vertical disc facing outward
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const cx = c2[0] + dx * 0.18, cz = c2[1] + dz * 0.18, cy = y + 0.6;
        const face = Array.from({ length: 10 }, (_, s) => {
          const ang = (s / 10) * Math.PI * 2;
          return [cx - dz * Math.cos(ang) * 0.1, cy + Math.sin(ang) * 0.1, cz + dx * Math.cos(ang) * 0.1];
        });
        E.noOutline = true;
        for (let s = 0; s < 10; s++) tri([cx, cy, cz], face[s], face[(s + 1) % 10], [dx, 0, dz], WHITE, m);
        E.noOutline = false;
        tri([cx + dx * 0.005, cy, cz + dz * 0.005], [cx + dx * 0.005, cy + 0.08, cz + dz * 0.005], [cx + dx * 0.005 - dz * 0.015, cy, cz + dz * 0.005 + dx * 0.015], [dx, 0, dz], SLATE, m);
      }
      box(c2, y + 0.85, y + 0.9, 0.2, [1, 0], WHITE, m);
      cone(c2, 0.26, y + 0.9, y + 1.35, 4, SLATE, m, Math.PI / 4);
    }
  };

  const lighthouseTop = (c2, y, m) => {
    prism(c2, 0.46, y, y + 0.06, 12, SLATE, m);
    prism(c2, 0.2, y + 0.06, y + 0.12, 8, SLATE, m);
    prism(c2, 0.18, y + 0.12, y + 0.46, 8, LAMP, m);
    prism(c2, 0.24, y + 0.46, y + 0.5, 8, SLATE, m);
    cone(c2, 0.26, y + 0.5, y + 0.82, 8, LH_RED, m);
    prism(c2, 0.02, y + 0.82, y + 0.95, 4, GOLD, m);
    E.R.fx.lamps.push({ x: c2[0], y: y + 0.29, z: c2[1], born: infoOf(m.v, m.L).info.b });
  };

  return { landmark, lighthouseTop };
}
