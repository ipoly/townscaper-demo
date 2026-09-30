// Resolves the bare 'three' specifiers the way the import map in index.html does
const MAP = {
  three: new URL('../vendor/three/three.module.min.js', import.meta.url).href,
};
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true };
  if (specifier.startsWith('three/addons/')) return { url: new URL('../vendor/three/addons/' + specifier.slice(13), import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
