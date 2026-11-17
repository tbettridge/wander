// Node resolve hook: `three` and `three/addons/...` load the stub beside it.
const stub = new URL('./three-stub.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'three' || specifier.startsWith('three/')) return { url: stub, shortCircuit: true };
  return next(specifier, context);
}
