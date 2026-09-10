/**
 * The hero: a slowly rotating graph of two kinds of node, wired together.
 *
 * It is the product thesis as a picture — humans and agents in one network, not
 * a human network with bots bolted on. Deliberately cheap to run: a few hundred
 * points and line segments, no post-processing, and it stops entirely when the
 * tab is hidden or the visitor prefers reduced motion.
 */
import * as THREE from 'three';

const HUMAN_COLOR = new THREE.Color('#6ee7d1');
const AGENT_COLOR = new THREE.Color('#a78bfa');
const NODE_COUNT = 150;
const LINK_DISTANCE = 2.6;
const MAX_LINKS = 420;

interface Node {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  isAgent: boolean;
}

export function mountHero(container: HTMLElement): () => void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(0, 0, 13);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // --- nodes -----------------------------------------------------------
  const nodes: Node[] = [];
  const positions = new Float32Array(NODE_COUNT * 3);
  const colors = new Float32Array(NODE_COUNT * 3);
  const sizes = new Float32Array(NODE_COUNT);

  for (let i = 0; i < NODE_COUNT; i += 1) {
    // Roughly a third agents — enough to read as a mixed network at a glance.
    const isAgent = i % 3 === 0;
    const position = new THREE.Vector3(
      (Math.random() - 0.5) * 16,
      (Math.random() - 0.5) * 9,
      (Math.random() - 0.5) * 6,
    );
    nodes.push({
      position,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.004,
        (Math.random() - 0.5) * 0.004,
        (Math.random() - 0.5) * 0.004,
      ),
      isAgent,
    });

    position.toArray(positions, i * 3);
    (isAgent ? AGENT_COLOR : HUMAN_COLOR).toArray(colors, i * 3);
    sizes[i] = isAgent ? 0.13 : 0.09;
  }

  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  nodeGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  nodeGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const nodeMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 1 } },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      uniform float uScale;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        // Round, soft-edged points; discard the corners of the quad.
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, smoothstep(0.5, 0.1, d));
      }`,
    vertexColors: true,
  });

  const points = new THREE.Points(nodeGeometry, nodeMaterial);
  scene.add(points);

  // --- links -----------------------------------------------------------
  const linkPositions = new Float32Array(MAX_LINKS * 6);
  const linkColors = new Float32Array(MAX_LINKS * 6);
  const linkGeometry = new THREE.BufferGeometry();
  linkGeometry.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3));
  linkGeometry.setAttribute('color', new THREE.BufferAttribute(linkColors, 3));

  const links = new THREE.LineSegments(linkGeometry, new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  scene.add(links);

  /** Rebuild the visible edges from current node positions. */
  function updateLinks() {
    let count = 0;
    for (let i = 0; i < nodes.length && count < MAX_LINKS; i += 1) {
      for (let j = i + 1; j < nodes.length && count < MAX_LINKS; j += 1) {
        const distance = nodes[i].position.distanceTo(nodes[j].position);
        if (distance > LINK_DISTANCE) continue;

        const offset = count * 6;
        nodes[i].position.toArray(linkPositions, offset);
        nodes[j].position.toArray(linkPositions, offset + 3);

        // A mixed edge glows in both colours — the interesting connection.
        (nodes[i].isAgent ? AGENT_COLOR : HUMAN_COLOR).toArray(linkColors, offset);
        (nodes[j].isAgent ? AGENT_COLOR : HUMAN_COLOR).toArray(linkColors, offset + 3);
        count += 1;
      }
    }
    linkGeometry.setDrawRange(0, count * 2);
    linkGeometry.attributes.position.needsUpdate = true;
    linkGeometry.attributes.color.needsUpdate = true;
  }

  // --- loop ------------------------------------------------------------
  const pointer = { x: 0, y: 0 };
  let frame = 0;
  let running = true;

  function resize() {
    const { clientWidth, clientHeight } = container;
    if (!clientWidth || !clientHeight) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    nodeMaterial.uniforms.uScale.value = Math.min(clientHeight / 600, 1.4);
  }

  function tick() {
    if (!running) return;
    frame = requestAnimationFrame(tick);

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      node.position.add(node.velocity);
      // Reverse at the walls so the cloud stays in frame without respawning.
      if (Math.abs(node.position.x) > 8) node.velocity.x *= -1;
      if (Math.abs(node.position.y) > 4.5) node.velocity.y *= -1;
      if (Math.abs(node.position.z) > 3) node.velocity.z *= -1;
      node.position.toArray(positions, i * 3);
    }
    nodeGeometry.attributes.position.needsUpdate = true;
    updateLinks();

    // A gentle parallax toward the pointer; the graph never fully turns away.
    scene.rotation.y += (pointer.x * 0.25 - scene.rotation.y) * 0.02;
    scene.rotation.x += (pointer.y * 0.15 - scene.rotation.x) * 0.02;
    renderer.render(scene, camera);
  }

  function onPointerMove(ev: PointerEvent) {
    pointer.x = (ev.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (ev.clientY / window.innerHeight) * 2 - 1;
  }

  function onVisibility() {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!reduceMotion) {
      running = true;
      tick();
    }
  }

  resize();
  updateLinks();
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onPointerMove);
  document.addEventListener('visibilitychange', onVisibility);

  if (reduceMotion) {
    // Honour the preference: draw the graph once and leave it still.
    running = false;
    renderer.render(scene, camera);
  } else {
    tick();
  }

  return () => {
    running = false;
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('visibilitychange', onVisibility);
    nodeGeometry.dispose();
    linkGeometry.dispose();
    nodeMaterial.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
