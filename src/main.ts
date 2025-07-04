import './style.css'
import * as THREE from 'three'
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js'
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js'
import { gsap } from 'gsap'

// Section content
const currentProjects = [
  {
    name: 'VoiceCert',
    url: 'https://www.voicecert.com',
    desc: 'VoiceCert: Real-time voice authentication for secure online interactions.'
  },
  {
    name: 'ChooseAStory',
    url: 'https://www.chooseastory.com',
    desc: 'ChooseAStory: Interactive storytelling platform for creators and readers.'
  },
  {
    name: 'Call My Echo',
    url: 'https://www.callmyecho.com',
    desc: 'Create an AI personal assistant and give a unique phone number to your friends to call it.'
  },
  {
    name: 'BazaarPlanner',
    url: 'https://www.bazaarplanner.com',
    desc: 'Simulator for the Tempo Storm game http://www.playthebazaar.com'
  }
]
const pastProjects = [
  {
    name: 'FreezeYourself',
    url: 'https://freezeyourself.com.au',
    desc: 'FreezeYourself: Innovative cryotherapy wellness experience.'
  },
  {
    name: 'CliqMusic',
    url: 'https://cliqmusic.com',
    desc: 'CliqMusic: Social music discovery and sharing platform.'
  },
  {
    name: 'SnapChallenge',
    url: 'https://www.snapchallenge.com',
    desc: 'SnapChallenge: Creative photo challenges for everyone.'
  }
]
const publicTools = [
  {
    name: 'POE Trade Helper',
    url: 'https://chromewebstore.google.com/detail/poe-trade-helper/pnfiflnonddjojlincicfgapoodpihjl',
    desc: 'Browser extension for Path of Exile trading.'
  },
  {
    name: 'POE Translator',
    url: '#',
    desc: 'Tool for translating Path of Exile content.'
  }
]

function injectSectionContent() {
  const current = document.getElementById('current-projects')
  const past = document.getElementById('past-projects')
  const tools = document.getElementById('public-tools')
  if (current) {
    current.innerHTML = `<div class="three-header" data-text="Current Projects"></div>` +
      currentProjects.map(p => `<div class="project"><a href="${p.url}" target="_blank">${p.name}</a><p>${p.desc}</p></div>`).join('')
    current.style.opacity = '0'
  }
  if (past) {
    past.innerHTML = `<div class="three-header" data-text="Past Projects"></div>` +
      pastProjects.map(p => `<div class="project"><a href="${p.url}" target="_blank">${p.name}</a><p>${p.desc}</p></div>`).join('')
    past.style.opacity = '0'
  }
  if (tools) {
    tools.innerHTML = `<div class="three-header" data-text="Public Tools"></div>` +
      publicTools.map(t => `<div class="tool"><a href="${t.url}" target="_blank">${t.name}</a><p>${t.desc}</p></div>`).join('')
    tools.style.opacity = '0'
  }
  // After injecting, initialize 3D headers
  init3DHeaders();
}

// 3D Text Animation
let scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, textMesh: THREE.Mesh
let animatingToHeader = false

// Store all header light update functions as {el, fn}
const headerLightUpdaters: Array<{el: HTMLElement, fn: (x: number, y: number) => void}> = [];

function create3DHeaderText(container: HTMLElement, text: string) {
  const width = container.offsetWidth || 600;
  const height = container.offsetHeight || 80;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(0, 0, 60);
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const loader = new FontLoader();
  loader.load('https://unpkg.com/three@0.150.1/examples/fonts/helvetiker_regular.typeface.json', (font) => {
    const geometry = new TextGeometry(text, {
      font: font,
      size: 16,
      depth: 2.5,
      curveSegments: 12,
      bevelEnabled: true,
      bevelThickness: 0.3,
      bevelSize: 0.2,
      bevelOffset: 0,
      bevelSegments: 5
    });
    const material = new THREE.MeshStandardMaterial({
      color: 0xe0e0e0, // silvery white
      metalness: 0.85,
      roughness: 0.25,
      emissive: 0x111111,
    });
    const mesh = new THREE.Mesh(geometry, material);
    geometry.center();
    mesh.position.set(0, 0, 0);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);
  });

  // Lighting (match original)
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const spot = new THREE.SpotLight(0xffffff, 1.2, 200, Math.PI / 6, 0.3, 1);
  spot.position.set(0, 40, 60);
  scene.add(spot);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.7);
  rimLight.position.set(-40, 60, 100);
  scene.add(rimLight);
  // Interactive mouse-following light (DirectionalLight)
  const mouseLight = new THREE.DirectionalLight(0xffffff, 2.5);
  mouseLight.position.set(0, 0, 60);
  scene.add(mouseLight);

  function render() {
    renderer.render(scene, camera);
  }
  // Call render once after setup
  render();
  // Update light and render on mouse move
  function updateLightFromMouse(x: number, y: number) {
    mouseLight.position.x = x * 40;
    mouseLight.position.y = -y * 20;
    mouseLight.position.z = 60;
    render();
  }
  headerLightUpdaters.push({el: container, fn: updateLightFromMouse});
}

function init3DHeaders() {
  // Clear previous updaters to avoid updating old/detached lights
  headerLightUpdaters.length = 0;
  const headers = document.querySelectorAll<HTMLElement>('.three-header');
  headers.forEach(header => {
    const text = header.dataset.text || header.textContent || '';
    header.innerHTML = '';
    create3DHeaderText(header, text);
  });
}

function setupHeaderLightTracking() {
  let lastUpdate = 0;
  function handleMove(e: MouseEvent | TouchEvent) {
    const now = Date.now();
    if (now - lastUpdate < 200) return;
    lastUpdate = now;
    headerLightUpdaters.forEach(({el, fn}) => {
      const rect = el.getBoundingClientRect();
      let clientX = 0, clientY = 0;
      if (e instanceof MouseEvent) {
        clientX = e.clientX;
        clientY = e.clientY;
      } else if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      }
      // Normalize x/y to [-1, 1] within the header canvas
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = ((clientY - rect.top) / rect.height) * 2 - 1;
      fn(x, y);
    });
  }
  window.addEventListener('mousemove', handleMove);
  window.addEventListener('touchmove', handleMove);
}

let introMouseLight: THREE.DirectionalLight | null = null;

function init3DText() {
  const container = document.getElementById('three-container')
  if (!container) return
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(45, container.offsetWidth / container.offsetHeight, 0.1, 1000)
  camera.position.set(0, 0, 50)
  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setSize(container.offsetWidth, container.offsetHeight)
  renderer.shadowMap.enabled = true
  container.appendChild(renderer.domElement)

  const loader = new FontLoader()
  loader.load('https://unpkg.com/three@0.150.1/examples/fonts/helvetiker_regular.typeface.json', (font) => {
    const geometry = new TextGeometry('Irrefutable Proof', {
      font: font,
      size: 5,
      depth: 1.5,
      curveSegments: 12,
      bevelEnabled: true,
      bevelThickness: 0.3,
      bevelSize: 0.2,
      bevelOffset: 0,
      bevelSegments: 5
    })
    // Cinematic material: metallic, glossy
    const material = new THREE.MeshStandardMaterial({
      color: 0xe0e0e0, // silvery white
      metalness: 0.85,
      roughness: 0.25,
      emissive: 0x111111,
    });
    textMesh = new THREE.Mesh(geometry, material);
    geometry.center();
    textMesh.position.set(0, 20, 0);
    textMesh.rotation.set(0, Math.PI, 0); // Start rotated on y-axis
    textMesh.castShadow = true;
    textMesh.receiveShadow = true;
    scene.add(textMesh);

    animateTextIn();
  })

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.5)
  scene.add(ambient)
  const spot = new THREE.SpotLight(0xffffff, 1.5, 200, Math.PI / 6, 0.3, 1)
  spot.position.set(0, 40, 60)
  spot.castShadow = true
  spot.shadow.mapSize.width = 2048
  spot.shadow.mapSize.height = 2048
  scene.add(spot)

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.7)
  rimLight.position.set(-40, 60, 100)
  scene.add(rimLight)

  // Add mouse-following light for intro text (DirectionalLight)
  introMouseLight = new THREE.DirectionalLight(0xffffff, 2.5);
  introMouseLight.position.set(0, 0, 60);
  scene.add(introMouseLight);

  const shadowGeo = new THREE.PlaneGeometry(60, 20)
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.25 })
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat)
  shadowMesh.position.set(0, -6, 0)
  shadowMesh.rotation.x = -Math.PI / 2
  shadowMesh.receiveShadow = true
  scene.add(shadowMesh)

  window.addEventListener('resize', onWindowResize)
  animate()
}

function animateTextIn() {
  if (!textMesh) return;
  gsap.fromTo(textMesh.position, { y: 40 }, { y: 0, duration: 1.6, ease: 'bounce.out' });
  gsap.fromTo(textMesh.rotation, { y: Math.PI }, { y: 0, duration: 1.2, ease: 'power2.out', onComplete: () => {
    if (textMesh) {
      textMesh.rotation.set(0, 0, 0); // Ensure facing camera
    }
  }});
}

function animateTextToHeader() {
  if (!textMesh || animatingToHeader) return
  animatingToHeader = true
  gsap.to(textMesh.position, { y: 15, z: -10, duration: 1, ease: 'power2.inOut' })
  gsap.to(textMesh.scale, { x: 0.3, y: 0.3, z: 0.3, duration: 1, ease: 'power2.inOut' })
  gsap.to(textMesh.rotation, { x: 0, y: 0, z: 0, duration: 1, ease: 'power2.inOut', onComplete: showHeader })
}

function showHeader() {
  // Hide 3D canvas, show header title and subtitle
  const container = document.getElementById('three-container')
  if (container) {
    container.style.pointerEvents = 'none'
    container.classList.add('shrunk')
  }
  const headerTitle = document.getElementById('header-title')
  if (headerTitle) {
    headerTitle.textContent = 'Group Network'
    gsap.fromTo(headerTitle, { y: -40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7 })
  }
  // Show menu button
  const menuBtn = document.getElementById('menu-btn')
  if (menuBtn) menuBtn.style.display = 'flex'
  
  // Show the rest of the site content
  const sections = document.querySelectorAll('.section')
  sections.forEach((section, index) => {
    (section as HTMLElement).style.display = 'block'
    gsap.fromTo(section, { opacity: 0, y: 50 }, { opacity: 1, y: 0, delay: 1 + index * 0.3, duration: 0.8 })
  })
  // Show the footer
  const footer = document.getElementById('footer');
  if (footer) {
    footer.style.display = 'flex';
    gsap.to(footer, { opacity: 1, delay: 1.5, duration: 0.8 });
  }
}

function onWindowResize() {
  const container = document.getElementById('three-container')
  if (!container || !renderer || !camera) return
  camera.aspect = container.offsetWidth / container.offsetHeight
  camera.updateProjectionMatrix()
  renderer.setSize(container.offsetWidth, container.offsetHeight)
}

function animate() {
  requestAnimationFrame(animate);
  if (textMesh && !animatingToHeader) {
    if (textMesh.rotation.y !== 0) {
      textMesh.rotation.y += 0.01;
    }
  }
  renderer && renderer.render(scene, camera);
}

function triggerHeaderTransition() {
  if (!animatingToHeader) animateTextToHeader()
}

function setupHeaderMenu() {
  const menuBtn = document.getElementById('menu-btn')
  const navMenu = document.getElementById('nav-menu')
  if (menuBtn && navMenu) {
    menuBtn.addEventListener('click', () => {
      navMenu.classList.toggle('open')
      menuBtn.classList.toggle('open')
    })
    // Close menu when a link is clicked
    navMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        navMenu.classList.remove('open');
        menuBtn.classList.remove('open');
      });
    });
  }
  // Hide menu by default
  if (menuBtn) menuBtn.style.display = 'none'
}

function setupScrollAndClick() {
  const container = document.getElementById('three-container')
  if (container) {
    container.addEventListener('click', triggerHeaderTransition)
    container.addEventListener('touchstart', triggerHeaderTransition)
  }
  window.addEventListener('scroll', () => {
    if (!animatingToHeader && window.scrollY > 10) {
      triggerHeaderTransition()
    }
  })
}

function setupIntroLightTracking() {
  const container = document.getElementById('three-container');
  if (!container) return;
  let lastUpdate = 0;
  function handleMove(e: MouseEvent | TouchEvent) {
    if (!container) return;
    const now = Date.now();
    if (now - lastUpdate < 200) return;
    lastUpdate = now;
    if (!introMouseLight) return;
    const rect = container.getBoundingClientRect();
    let clientX = 0, clientY = 0;
    if (e instanceof MouseEvent) {
      clientX = e.clientX;
      clientY = e.clientY;
    } else if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    }
    // Normalize x/y to [-1, 1] within the intro canvas
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((clientY - rect.top) / rect.height) * 2 - 1;
    introMouseLight.position.x = x * 40;
    introMouseLight.position.y = -y * 20;
    introMouseLight.position.z = 60;
  }
  container.addEventListener('mousemove', handleMove);
  container.addEventListener('touchmove', handleMove);
}

// Inject content and initialize
injectSectionContent();
setupHeaderMenu();
setupScrollAndClick();
init3DText();
setupHeaderLightTracking();
setupIntroLightTracking();
