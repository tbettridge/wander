// Carriage lantern light without scene lights.
//
// A real THREE.PointLight costs every lit program in the scene: adding or
// hiding one changes the light count and recompiles them all. While the player
// is off the train, the carriage lamps still glow at night, but their light on
// the train is drawn by the train's own materials instead. Each patched
// material runs three's own point-light path (getDistanceAttenuation, then the
// material's RE_Direct) for every lamp position, so the drawn light matches the
// real one on every train surface, diffuse and specular alike. Only the train's
// materials pay for it, and changing the level or the lamp positions is a
// uniform update, never a recompile. When the player boards, the real lights
// take over and this drawn copy goes to zero.
import * as THREE from 'three';

export const TRAIN_LANTERN_MAX = 4;

// GLSL for the drawn lamps. It sits right after three's own light setup, where
// `directLight`, `geometryPosition`, `geometryNormal`, `geometryViewDir`,
// `geometryClearcoatNormal`, `material` and `reflectedLight` are all in scope.
// Lamp positions arrive in world space and are taken to view space here, the
// space three's lighting works in, so every camera (both XR eyes included)
// sees the same light.
const BAKED_LANTERN_GLSL = /* glsl */`
#if defined( RE_Direct )
if ( uTrainLanternBaked > 0.0 ) {
	for ( int i = 0; i < TRAIN_LANTERN_MAX; i ++ ) {
		if ( i >= uTrainLanternCount ) break;
		vec3 trainLanternView = ( viewMatrix * vec4( uTrainLanternWorld[ i ], 1.0 ) ).xyz;
		vec3 trainLanternVector = trainLanternView - geometryPosition;
		directLight.direction = normalize( trainLanternVector );
		directLight.color = uTrainLanternColor * uTrainLanternBaked
			* getDistanceAttenuation( length( trainLanternVector ), uTrainLanternDistance, uTrainLanternDecay );
		directLight.visible = true;
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
}
#endif
`;

const DECLARATIONS = /* glsl */`
#define TRAIN_LANTERN_MAX ${TRAIN_LANTERN_MAX}
uniform vec3 uTrainLanternWorld[ TRAIN_LANTERN_MAX ];
uniform int uTrainLanternCount;
uniform vec3 uTrainLanternColor;
uniform float uTrainLanternBaked;
uniform float uTrainLanternDistance;
uniform float uTrainLanternDecay;
`;

export class TrainLanternLight {
  /** `color`, `intensity`, `distance` and `decay` must be those of the real
   * carriage PointLights, so the drawn light and the real light agree. */
  constructor({ color = 0xffc173, intensity = 2, distance = 10, decay = 1 } = {}) {
    this.intensity = intensity;
    this.baseColor = new THREE.Color(color);
    this.uniforms = {
      uTrainLanternWorld: { value: Array.from({ length: TRAIN_LANTERN_MAX }, () => new THREE.Vector3()) },
      uTrainLanternCount: { value: 0 },
      uTrainLanternColor: { value: this.baseColor.clone().multiplyScalar(intensity) },
      uTrainLanternBaked: { value: 0 },
      uTrainLanternDistance: { value: distance },
      uTrainLanternDecay: { value: decay },
    };
    this._patched = new WeakSet();
  }

  /** Teach a lit material to draw the lamps. Keeps any earlier compile hook. */
  patch(material) {
    if (!material || this._patched.has(material)) return material;
    if (!(material.isMeshStandardMaterial || material.isMeshLambertMaterial
      || material.isMeshPhongMaterial || material.isMeshToonMaterial)) return material;
    this._patched.add(material);
    const previous = material.onBeforeCompile;
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader, renderer) => {
      previous?.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = DECLARATIONS + shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>\n${BAKED_LANTERN_GLSL}`,
      );
    };
    const previousKey = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => `${previousKey?.() || ''}:train-lantern-bake-v1`;
    material.needsUpdate = true;
    return material;
  }

  /** Lamp positions for this frame, from the real lights' world transforms. */
  setLamps(lights) {
    const count = Math.min(TRAIN_LANTERN_MAX, lights.length);
    const positions = this.uniforms.uTrainLanternWorld.value;
    for (let i = 0; i < count; i++) lights[i].getWorldPosition(positions[i]);
    this.uniforms.uTrainLanternCount.value = count;
  }

  /** 0..1 level of the drawn light (multiplies the real lights' colour). */
  setBakedLevel(level) {
    this.uniforms.uTrainLanternBaked.value = Math.max(0, Number(level) || 0);
  }
}
