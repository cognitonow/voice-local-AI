import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const STATE_LIGHT = {
  idle: 0xe9d9bd, listening: 0x8fd6c6, thinking: 0xb7a8e6, speaking: 0xf0b45a, offline: 0x6c7a80,
};

export function createStage(host, getMouth) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.xr.enabled = true;
  host.appendChild(renderer.domElement);
  const vrButton = VRButton.createButton(renderer);
  vrButton.id = 'vrbutton';
  document.body.appendChild(vrButton);
  setTimeout(() => { if (/not/i.test(vrButton.textContent)) vrButton.hidden = true; else vrButton.textContent = 'Enter VR'; }, 1500);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f2a31);
  scene.fog = new THREE.Fog(0x0f2a31, 3.5, 9);

  // Rig: the viewer stands 1.25 m in front of the avatar (desktop and VR).
  const rig = new THREE.Group();
  rig.position.set(0, 0, 1.75);
  scene.add(rig);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 40);
  camera.position.set(0, 1.47, 0);
  rig.add(camera);
  let lookY = 1.36;

  scene.add(new THREE.HemisphereLight(0xcfe3e0, 0x0f2a31, 0.55));
  const key = new THREE.SpotLight(STATE_LIGHT.idle, 26, 8, 0.55, 0.6, 1.6);
  key.position.set(0.4, 3.4, 1.4);
  key.target.position.set(0, 1.2, 0);
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x8fd6c6, 0.9);
  rim.position.set(-1.5, 2.2, -2);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xfff1e0, 0.7);
  fill.position.set(0.3, 1.5, 3);
  scene.add(fill);

  // Floor with a soft pool of light that takes on the conversation state colour.
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(1.6, 64),
    new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false, color: STATE_LIGHT.idle })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.001;
  scene.add(pool);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 48),
    new THREE.MeshStandardMaterial({ color: 0x12333b, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  let avatar = buildProcedural(); avatar.isDefault = true;
  scene.add(avatar.root);

  const targetColor = new THREE.Color(STATE_LIGHT.idle);
  let state = 'idle';

  function setState(s) {
    state = s;
    targetColor.set(STATE_LIGHT[s] ?? STATE_LIGHT.idle);
  }

  function useDefault() {
    if (avatar.isDefault) return;
    scene.remove(avatar.root);
    avatar = buildProcedural(); avatar.isDefault = true;
    avatar.setExpression?.(face);
    scene.add(avatar.root);
  }
  async function loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('That file is not a VRM avatar.');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    const h = vrm.humanoid;
    const lArm = h.getNormalizedBoneNode('leftUpperArm');
    const rArm = h.getNormalizedBoneNode('rightUpperArm');
    if (lArm) lArm.rotation.z = -1.2;
    if (rArm) rArm.rotation.z = 1.2;
    if (vrm.lookAt) vrm.lookAt.target = camera;
    vrm.update(0);
    const head = h.getNormalizedBoneNode('head');
    if (head) {
      const p = new THREE.Vector3();
      head.getWorldPosition(p);
      lookY = p.y + 0.04;
      camera.position.y = lookY + 0.1;
      lookY -= 0.08;
    }
    scene.remove(avatar.root);
    avatar = vrmAvatar(vrm);
    avatar.setExpression?.(face);
    scene.add(avatar.root);
  }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    key.color.lerp(targetColor, 0.06);
    pool.material.color.lerp(targetColor, 0.06);
    if (!renderer.xr.isPresenting) camera.lookAt(new THREE.Vector3(0, lookY, 0));
    avatar.update(dt, t, getMouth(), state);
    renderer.render(scene, camera);
  });

  let face = 'neutral';
  return { setState, loadVRM, useDefault, cue: (style) => avatar.cue && avatar.cue(style),
    setExpression: (f) => { face = f; avatar.setExpression?.(f); } };
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- built-in avatar
function buildProcedural() {
  const root = new THREE.Group();
  const mat = (color, roughness = 0.6) => new THREE.MeshStandardMaterial({ color, roughness });
  const skin = mat(0xc28a68, 0.55);
  const hairM = mat(0x2a1c17, 0.45);
  const jacket = mat(0x6b2733, 0.7);
  const shirt = mat(0xeeeae2, 0.8);
  const dark = mat(0x1d1414, 0.3);
  const white = mat(0xf7f5f0, 0.25);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.5, 8, 24), jacket);
  torso.scale.set(1.45, 1, 0.6);
  torso.position.y = 1.0;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.06, 24), shirt);
  collar.position.y = 1.34;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.042, 0.1, 24), skin);
  neck.position.y = 1.38;
  root.add(torso, collar, neck);

  // Head group pivots at the top of the neck.
  const head = new THREE.Group();
  head.position.y = 1.41;
  root.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.1, 48, 32), skin);
  skull.scale.set(0.9, 1.1, 0.96);
  skull.position.y = 0.1;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.107, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.42), hairM);
  hair.scale.set(0.92, 1.1, 1.0);
  hair.position.set(0, 0.108, -0.004);
  hair.rotation.x = -0.35;
  const bun = new THREE.Mesh(new THREE.SphereGeometry(0.042, 24, 16), hairM);
  bun.position.set(0, 0.11, -0.1);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), skin);
  nose.scale.set(0.9, 1.2, 1);
  nose.position.set(0, 0.085, 0.094);
  head.add(skull, hair, bun, nose);

  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(0.034 * sx, 0.112, 0.081);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.013, 20, 14), white);
    ball.scale.z = 0.6;
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.0072, 16, 12), dark);
    pupil.position.z = 0.0068;
    eye.add(ball, pupil);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.0045, 0.006), hairM);
    brow.position.set(0.034 * sx, 0.138, 0.084);
    brow.rotation.z = 0.06 * sx;
    head.add(eye, brow);
    eyes.push({ eye, pupil, brow });
  }

  const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.019, 32), mat(0x5a1f26, 0.4));
  mouth.position.set(0, 0.052, 0.091);
  head.add(mouth);

  let blinkT = 2 + Math.random() * 3, blink = 0, mouthOpen = 0, nodT = 0, nodDir = 0;
  const pose = { ...FACE_POSE.neutral }; let target = FACE_POSE.neutral;
  return {
    root,
    cue(style) { nodT = 0.5; nodDir = style === 'shake' ? 1 : 0; },
    setExpression(f) { target = FACE_POSE[f] || FACE_POSE.neutral; },
    update(dt, t, m, state) {
      if (nodT > 0) nodT = Math.max(0, nodT - dt);
      for (const k of ['browY', 'browTilt', 'eye', 'mouthW', 'tremble']) pose[k] += (target[k] - pose[k]) * Math.min(1, dt * 4);
      mouthOpen += (m - mouthOpen) * Math.min(1, dt * 18);
      mouth.scale.set((1 - mouthOpen * 0.25) * pose.mouthW, 0.14 + mouthOpen * 0.95, 1);

      blinkT -= dt;
      if (blinkT < 0) { blink = 1; blinkT = 2.5 + Math.random() * 3.5; }
      blink = Math.max(0, blink - dt * 9);
      const lid = 1 - Math.sin(blink * Math.PI) * 0.92;

      const thinking = state === 'thinking';
      const listening = state === 'listening';
      const lookX = thinking ? 0.0035 : Math.sin(t * 0.4) * 0.0012;
      const lookY = thinking ? 0.003 : 0;
      for (const e of eyes) {
        const sx = Math.sign(e.eye.position.x);
        e.eye.scale.y = lid * pose.eye;
        e.pupil.position.x = lookX;
        e.pupil.position.y = lookY;
        e.brow.position.y = 0.138 + pose.browY + (thinking ? 0.004 : 0) + mouthOpen * 0.003;
        e.brow.rotation.z = 0.06 * sx + pose.browTilt * sx; // negative tilt = inner ends up (worried)
      }
      const nod = state === 'speaking' ? Math.sin(t * 5.5) * 0.02 * mouthOpen : 0;
      const cueAmt = nodT > 0 ? Math.sin((0.5 - nodT) / 0.5 * Math.PI) : 0;
      const nodPulse = nodDir ? 0 : cueAmt * 0.12;
      const shakePulse = nodDir ? Math.sin((0.5 - nodT) * 40) * cueAmt * 0.18 : 0;
      head.rotation.x = Math.sin(t * 0.7) * 0.015 + nod + nodPulse + (thinking ? -0.06 : 0);
      const tremble = pose.tremble * Math.sin(t * 37) * 0.006;
      head.rotation.y = Math.sin(t * 0.33) * 0.05 + shakePulse + tremble;
      head.rotation.z += ((listening ? 0.07 : 0) + Math.sin(t * 0.5) * 0.01 - head.rotation.z) * Math.min(1, dt * 3);
      torso.scale.y = 1 + Math.sin(t * 1.6) * 0.006;
    },
  };
}

// Facial poses for the mood engine's faces. Built-in avatar: brows, eyes, mouth width, tremble.
// VRM characters: blend of their standard expressions.
const FACE_POSE = {
  neutral:    { browY: 0,      browTilt: 0,     eye: 1,    mouthW: 1,    tremble: 0, vrm: {} },
  panicked:   { browY: 0.006,  browTilt: -0.25, eye: 1.2,  mouthW: 0.85, tremble: 1, vrm: { surprised: 0.6, sad: 0.3 } },
  relieved:   { browY: 0.002,  browTilt: -0.1,  eye: 0.85, mouthW: 1.15, tremble: 0, vrm: { relaxed: 0.6, happy: 0.3 } },
  suspicious: { browY: -0.004, browTilt: 0.25,  eye: 0.7,  mouthW: 0.9,  tremble: 0, vrm: { angry: 0.3 } },
  deadpan:    { browY: -0.002, browTilt: 0,     eye: 0.75, mouthW: 1,    tremble: 0, vrm: { relaxed: 0.2 } },
  happy:      { browY: 0.003,  browTilt: -0.05, eye: 0.9,  mouthW: 1.25, tremble: 0, vrm: { happy: 0.8 } },
  sad:        { browY: 0.001,  browTilt: -0.3,  eye: 0.85, mouthW: 0.85, tremble: 0, vrm: { sad: 0.7 } },
  angry:      { browY: -0.005, browTilt: 0.35,  eye: 0.85, mouthW: 0.95, tremble: 0.3, vrm: { angry: 0.7 } },
};

function vrmAvatar(vrm) {
  let blinkT = 2, blink = 0, mouthOpen = 0, nodT = 0, nodDir = 0;
  const em = vrm.expressionManager;
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  const spine = vrm.humanoid.getNormalizedBoneNode('spine');
  const has = (n) => !!em?.getExpression?.(n);
  const mix = { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0 }; let target = FACE_POSE.neutral;
  return {
    root: vrm.scene,
    setExpression(f) { target = FACE_POSE[f] || FACE_POSE.neutral; },
    cue(style) { nodT = 0.5; nodDir = style === 'shake' ? 1 : 0; },
    update(dt, t, m, state) {
      mouthOpen += (m - mouthOpen) * Math.min(1, dt * 18);
      if (nodT > 0) nodT = Math.max(0, nodT - dt);
      blinkT -= dt;
      if (blinkT < 0) { blink = 1; blinkT = 2.5 + Math.random() * 3.5; }
      blink = Math.max(0, blink - dt * 9);
      if (em) {
        em.setValue('aa', mouthOpen);
        em.setValue('blink', Math.sin(blink * Math.PI));
        for (const k of Object.keys(mix)) {
          mix[k] += ((target.vrm[k] || 0) - mix[k]) * Math.min(1, dt * 4);
          if (has(k)) em.setValue(k, mix[k]);
        }
      }
      if (head) {
        const cueAmt = nodT > 0 ? Math.sin((0.5 - nodT) / 0.5 * Math.PI) : 0;
        head.rotation.x = Math.sin(t * 0.7) * 0.02 + (nodDir ? 0 : cueAmt * 0.14) + (state === 'thinking' ? -0.08 : 0);
        if (nodDir) head.rotation.y = Math.sin((0.5 - nodT) * 40) * cueAmt * 0.2;
        head.rotation.z = state === 'listening' ? 0.06 : Math.sin(t * 0.5) * 0.015;
      }
      if (spine) spine.rotation.x = Math.sin(t * 1.6) * 0.01;
      vrm.update(dt);
    },
  };
}
