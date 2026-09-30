# Cuter houses

Goal: move the houses from "illustrated architecture" towards the chunky, toy-like look of
the original Townscaper.

## Diagnosis

| # | Now | Townscaper | Where |
|---|-----|------------|-------|
| 1 | Low roofs (`ROOF_RISE = 0.45`), no eaves | Steep, oversized roofs with thick overhanging eaves | `town.js` roof pass |
| 2 | Two small windows per face per floor, glazing bars, lintels, sills | One big centered window per face, chunky frame, no bars | `town.js` `wall()` |
| 3 | Dark outlines (`#2e2a28`, 0.6) on every crease, hard corners | Almost no outlines; volumes read through soft corners and AO | `main.js` `outlineMaterial` |
| 4 | Thin, tall stilts with braces | Thick stone pillars and arches | `town.js` posts |
| 5 | Tall floors (`LEVEL_H = 0.85`) | Squatter floors | `town.js` `LEVEL_H` |
| 6 | Muted, dusty palette | More saturated walls, stronger roof contrast | `town.js` `PALETTE` / `ROOF_OF` |

## Plan

### Phase 1: parameters and local geometry

- [x] 1. Roofs: steeper rise, overhanging eaves with a thick rim
- [x] 2. Windows: one bigger centered window per face, no glazing bars, rounder variants
- [x] 3. Outlines: warmer and much lighter
- [ ] 4. Stilts: thicker posts, fewer braces
- [ ] 5. Floor height: lower `LEVEL_H`, recheck stairs / doors / balconies
- [ ] 6. Palette: +10-20% saturation on walls and roofs

### Phase 2: rounded volumes

- [ ] Bevelled / rounded wall corners (transition faces at corners, keep outline pairing intact)
- [ ] Rounded ridges and eaves
- [ ] Simple vertex AO (wall feet, under eaves) to replace outlines

## Progress log

- 2026-09-30: diagnosis done; starting phase 1 items 1-3.
- 2026-09-30: phase 1 items 1-3 done.
 - Roofs: `ROOF_RISE` 0.45 -> 0.6. New `eaves()` in `town.js` adds a wedge (top, rim, shaded
   underside) past every outer wall of a pitched roof; strips share their end at edge midpoints and
   mitre at quad centers, open ends are capped. Tunables: `EAVE`, `EAVE_DROP`, `EAVE_RIM`.
 - Windows: the two per-half-wall panes are replaced by one window centered on the face, drawn
   half by each half-wall in world units (`window1()`, `porthole()`). Variants: plain, arched,
   shuttered, balcony (centered), round. Glazing bars and the double small pane are gone.
 - Outlines: `#2e2a28` @ 0.6 -> `#6b5446` @ 0.3.
 - Known leftovers: windows fold where a face kinks at its midpoint on the irregular grid; lean-to
   roofs (now higher) hide more of the lower part of the taller neighbour's windows.
