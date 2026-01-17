import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, CameraControls, Line, Sparkles, Stars, Text } from '@react-three/drei';
import { EffectComposer, Bloom, Noise, Vignette, ChromaticAberration } from '@react-three/postprocessing';
import * as THREE from 'three';
import { API_BASE } from './lib/api';

const promptSeeds = [
  'A memory that still vibrates in my body is...',
  'I want the world to remember the day when...',
  'A quiet moment that reshaped me was...',
  'The sound of home feels like...',
  'A story I never told because I was afraid is...'
];


function normalizeMood(mood) {
  if (!mood || typeof mood !== 'string') return 'Fragment';
  const trimmed = mood.trim();
  return trimmed.length ? trimmed : 'Fragment';
}

function seededPosition(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const rand = (offset) => {
    const x = Math.sin(hash + offset) * 10000;
    return x - Math.floor(x);
  };
  return new THREE.Vector3((rand(1) - 0.5) * 90, (rand(2) - 0.5) * 90, (rand(3) - 0.5) * 90);
}

function moodAnchor(mood) {
  const key = normalizeMood(mood).toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  const rand = (offset) => {
    const x = Math.sin(hash + offset) * 10000;
    return x - Math.floor(x);
  };
  return new THREE.Vector3((rand(11) - 0.5) * 70, (rand(12) - 0.5) * 70, (rand(13) - 0.5) * 70);
}

function hasUsableEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== 3) return false;
  if (!embedding.every((val) => Number.isFinite(val))) return false;
  return embedding.some((val) => Math.abs(val) > 0.0001);
}

function getMemoryPosition(memory) {
  if (hasUsableEmbedding(memory.embedding)) {
    const base = new THREE.Vector3(...memory.embedding);
    const length = base.length();
    if (length > 0.0001) {
      base.normalize().multiplyScalar(45);
      const drift = seededPosition(memory._id || memory.text || 'seed').multiplyScalar(0.15);
      return base.add(drift);
    }
  }
  return seededPosition(memory._id || memory.text || 'seed');
}

function StarNode({ mem, isSelected, onSelect, density = 0 }) {
  const meshRef = useRef();
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.elapsedTime;
    const pulse = 0.15 * Math.sin(t * 1.4 + mem.position.x * 0.15);
    const densityBoost = Math.min(density, 6) * 0.05;
    meshRef.current.scale.setScalar(1 + pulse + densityBoost + (isSelected ? 0.2 : 0));
  });

  return (
    <mesh
      ref={meshRef}
      position={mem.position}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(mem);
      }}
    >
      <sphereGeometry args={[isSelected ? 0.9 : 0.55, 24, 24]} />
      <meshBasicMaterial color={mem.color} toneMapped={false} />
      <pointLight distance={16} intensity={(isSelected ? 3 : 1.4) + Math.min(density, 6) * 0.18} color={mem.color} />
    </mesh>
  );
}

function buildArcPoints(a, b, seed) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const sway = seededPosition(seed || 'arc').normalize();
  const lift = Math.min(a.distanceTo(b) * 0.2, 18);
  mid.add(sway.multiplyScalar(lift));
  return [a, mid, b];
}

function buildClusterMap(memories, links) {
  const parent = new Map();
  memories.forEach((mem) => {
    if (mem?._id) parent.set(mem._id, mem._id);
  });

  const find = (id) => {
    let root = parent.get(id);
    if (!root) return id;
    while (root !== parent.get(root)) {
      root = parent.get(root);
    }
    let current = id;
    while (current !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };

  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  (links || []).forEach((link) => {
    if (!link.fromId || !link.toId) return;
    union(link.fromId, link.toId);
  });

  const moodCounts = new Map();
  memories.forEach((mem) => {
    if (!mem?._id) return;
    const root = find(mem._id);
    if (!moodCounts.has(root)) moodCounts.set(root, new Map());
    const counts = moodCounts.get(root);
    const mood = normalizeMood(mem.mood);
    counts.set(mood, (counts.get(mood) || 0) + 1);
  });

  const clusterLabelById = new Map();
  memories.forEach((mem) => {
    if (!mem?._id) return;
    const root = find(mem._id);
    const counts = moodCounts.get(root);
    if (!counts) return;
    let topMood = null;
    let topCount = -1;
    counts.forEach((count, mood) => {
      if (count > topCount) {
        topCount = count;
        topMood = mood;
      }
    });
    clusterLabelById.set(mem._id, topMood || normalizeMood(mem.mood));
  });

  return clusterLabelById;
}

function LinkArcs({ links, nodesById, selectedId }) {
  const { camera } = useThree();
  const [fadeFactor, setFadeFactor] = useState(0.2);

  const center = useMemo(() => {
    if (!nodesById.size) return new THREE.Vector3();
    const centerVec = new THREE.Vector3();
    nodesById.forEach((node) => centerVec.add(node.position));
    centerVec.divideScalar(nodesById.size);
    return centerVec;
  }, [nodesById]);

  useFrame(() => {
    if (!camera || !nodesById.size) return;
    const distance = camera.position.distanceTo(center);
    const farStart = 260;
    const farEnd = 180;
    const nearStart = 26;
    const nearEnd = 60;
    const farFactor = THREE.MathUtils.clamp((farStart - distance) / (farStart - farEnd), 0, 1);
    const nearFactor = THREE.MathUtils.clamp((distance - nearStart) / (nearEnd - nearStart), 0, 1);
    const next = Math.min(farFactor, nearFactor);
    setFadeFactor((prev) => (Math.abs(prev - next) > 0.02 ? next : prev));
  });

  const preparedLinks = useMemo(() => {
    return links
      .map((link) => {
        const a = nodesById.get(link.fromId);
        const b = nodesById.get(link.toId);
        if (!a || !b) return null;
        const baseColor = link.color
          ? link.color
          : new THREE.Color(a.color).lerp(new THREE.Color(b.color), 0.5).getStyle();
        const isActive = selectedId && (a._id === selectedId || b._id === selectedId);
        const baseOpacity =
          link.type === 'family'
            ? 0.32
            : link.type === 'curated'
            ? 0.28
            : link.type === 'directional'
            ? 0.22
            : 0.12;
        const opacity = isActive ? Math.max(0.32, baseOpacity * 1.6) : baseOpacity;
        const lineWidth =
          link.type === 'family' ? 1.0 : link.type === 'curated' ? 0.9 : link.type === 'directional' ? 0.75 : 0.55;
        return {
          id: link.id || `${link.fromId}-${link.toId}`,
          points: buildArcPoints(a.position.clone(), b.position.clone(), link.id),
          color: baseColor,
          opacity,
          lineWidth,
          isActive
        };
      })
      .filter(Boolean);
  }, [links, nodesById, selectedId]);

  return (
    <group>
      {preparedLinks.map((link) => (
        <Line
          key={link.id}
          points={link.points}
          color={link.color}
          lineWidth={link.lineWidth}
          transparent
          opacity={link.isActive ? link.opacity : link.opacity * fadeFactor}
        />
      ))}
    </group>
  );
}

function LivingCartography({ memories, onSelect, selectedId, showLabels, links, linkCounts }) {
  const safeMemories = useMemo(() => {
    return memories.map((m) => {
      const pos = getMemoryPosition(m).add(moodAnchor(m.mood).multiplyScalar(0.6));
      const mood = normalizeMood(m.mood);
      let color = m.color || '#ffffff';
      if (!m.color) {
        const moodKey = mood.toLowerCase();
        if (moodKey.includes('fear') || moodKey.includes('anger')) color = '#ff5d3a';
        if (moodKey.includes('joy') || moodKey.includes('light')) color = '#ffd35c';
        if (moodKey.includes('sad') || moodKey.includes('grief')) color = '#57d4ff';
      }

      return { ...m, mood, position: pos, color, tags: m.tags || [] };
    });
  }, [memories]);

  const clusterLabelById = useMemo(() => buildClusterMap(safeMemories, links), [safeMemories, links]);

  const labels = useMemo(() => {
    const groups = {};
    safeMemories.forEach((m) => {
      const key = clusterLabelById.get(m._id) || m.mood || 'Unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m.position);
    });

    return Object.keys(groups).map((key) => {
      const points = groups[key];
      const center = new THREE.Vector3();
      points.forEach((p) => center.add(p));
      center.divideScalar(points.length);
      return { text: key.toUpperCase(), pos: center, key };
    });
  }, [safeMemories]);

  const nodesById = useMemo(() => {
    const map = new Map();
    safeMemories.forEach((mem) => map.set(mem._id, mem));
    return map;
  }, [safeMemories]);

  return (
    <group>
      {showLabels &&
        labels.map((label, i) => (
          <Billboard key={i} position={[label.pos.x, label.pos.y + 9, label.pos.z]}>
            <Text fontSize={3.2} color="#ffffff" fillOpacity={0.22}>
              {label.text}
            </Text>
          </Billboard>
        ))}

      <LinkArcs links={links} nodesById={nodesById} selectedId={selectedId} />

      {safeMemories.map((mem) => (
        <StarNode
          key={mem._id}
          mem={mem}
          density={linkCounts[mem._id] || 0}
          isSelected={selectedId === mem._id}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}

function NebulaClouds() {
  const groupRef = useRef();
  const clouds = useMemo(
    () => [
      { position: [-30, 12, -120], scale: [1.4, 1.1, 1.2], color: '#5ed1ff', opacity: 0.08 },
      { position: [26, -10, -150], scale: [1.2, 1.3, 1.1], color: '#ff8a6a', opacity: 0.07 },
      { position: [6, 20, -180], scale: [1.6, 1.2, 1.4], color: '#f6ffb0', opacity: 0.06 }
    ],
    []
  );

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.y = Math.sin(clock.elapsedTime * 0.03) * 0.1;
    groupRef.current.rotation.x = Math.cos(clock.elapsedTime * 0.02) * 0.08;
  });

  return (
    <group ref={groupRef}>
      {clouds.map((cloud, index) => (
        <mesh key={index} position={cloud.position} scale={cloud.scale}>
          <sphereGeometry args={[18, 32, 32]} />
          <meshBasicMaterial
            color={cloud.color}
            transparent
            opacity={cloud.opacity}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function CameraDrift({ controlsRef, enabled }) {
  useFrame((_, delta) => {
    if (!enabled || !controlsRef.current) return;
    controlsRef.current.rotate(0.08 * delta, 0.03 * delta, true);
  });
  return null;
}

export default function App() {
  const [memories, setMemories] = useState([]);
  const [selectedMemory, setSelectedMemory] = useState(null);
  const [activeView, setActiveView] = useState('HOME');
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [toast, setToast] = useState(null);
  const [isInteracting, setIsInteracting] = useState(false);
  const [links, setLinks] = useState([]);
  const [timeScrub, setTimeScrub] = useState(1);
  const [familyBrief, setFamilyBrief] = useState(null);
  const [familyBriefStatus, setFamilyBriefStatus] = useState('idle');
  const [selectedFamily, setSelectedFamily] = useState('NONE');

  const controlsRef = useRef();
  const toastTimerRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/memories`)
      .then((res) => res.json())
      .then((data) => setMemories(data))
      .catch((err) => console.error('Database Offline', err));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/links`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setLinks(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Linking Offline', err));
  }, [memories.length]);

  useEffect(() => {
    if (selectedMemory && controlsRef.current) {
      const pos = getMemoryPosition(selectedMemory);
      const offset = new THREE.Vector3(0, 0.35, 1).normalize().multiplyScalar(18);
      controlsRef.current.setLookAt(
        pos.x + offset.x,
        pos.y + offset.y,
        pos.z + offset.z,
        pos.x,
        pos.y,
        pos.z,
        true
      );
    }
  }, [selectedMemory]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const cluster = useMemo(() => {
    if (!memories.length) {
      return { center: new THREE.Vector3(0, 0, 0), radius: 70 };
    }
    const positions = memories.map((m) => getMemoryPosition(m));
    const center = new THREE.Vector3();
    positions.forEach((p) => center.add(p));
    center.divideScalar(positions.length);
    let radius = 0;
    positions.forEach((p) => {
      radius = Math.max(radius, p.distanceTo(center));
    });
    return { center, radius: Math.max(radius, 70) };
  }, [memories]);

  const handleSelect = (mem) => {
    setSelectedMemory(mem);
  };

  const handleResetView = useCallback(() => {
    setSelectedMemory(null);
    if (!controlsRef.current) return;
    const distance = Math.max(90, cluster.radius * 2.2);
    controlsRef.current.setLookAt(
      cluster.center.x,
      cluster.center.y,
      cluster.center.z + distance,
      cluster.center.x,
      cluster.center.y,
      cluster.center.z,
      true
    );
  }, [cluster]);

  const setControlsRef = useCallback(
    (node) => {
      controlsRef.current = node;
      if (node && activeView === 'CONSTELLATION') {
        requestAnimationFrame(() => handleResetView());
      }
    },
    [activeView, handleResetView]
  );

  useEffect(() => {
    const handleKey = (event) => {
      const tagName = event.target?.tagName?.toLowerCase();
      if (tagName === 'textarea' || tagName === 'input') return;
      if (event.key === 'Escape') setActiveView('CONSTELLATION');
      if (event.key.toLowerCase() === 'r') handleResetView();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleResetView]);

  useEffect(() => {
    if (activeView === 'CONSTELLATION') handleResetView();
  }, [activeView, handleResetView]);

  const handleSeed = (seed) => {
    setInputText((prev) => (prev ? `${prev}\n${seed}` : seed));
  };

  const handleFamilyBrief = async (mood) => {
    if (!mood || mood === 'NONE') return;
    setFamilyBriefStatus('loading');
    setFamilyBrief(null);
    try {
      const res = await fetch(`${API_BASE}/memories/family/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mood })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Brief failed');
      setFamilyBrief(data);
      setFamilyBriefStatus('ready');
    } catch (error) {
      setFamilyBriefStatus('error');
    }
  };

  const handleBriefClose = () => {
    setFamilyBrief(null);
    setFamilyBriefStatus('idle');
    setSelectedFamily('NONE');
  };

  const showToast = (message, tone = 'info') => {
    setToast({ message, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  };

  const handleDeposit = async () => {
    if (!inputText.trim()) return;
    setIsProcessing(true);
    try {
      const res = await fetch(`${API_BASE}/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: inputText, location: 'Web' })
      });
      const newMem = await res.json();
      if (!res.ok) throw new Error(newMem.error || 'Ingestion Failed');

      setMemories((prev) => [newMem, ...prev]);
      setInputText('');
      showToast(`Classified: ${normalizeMood(newMem.mood)}`, 'success');
      setActiveView('CONSTELLATION');
    } catch (e) {
      showToast('Transmission failed. Check the server.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const timeBounds = useMemo(() => {
    const dates = memories
      .map((mem) => new Date(mem.createdAt))
      .filter((date) => Number.isFinite(date.getTime()));
    if (!dates.length) return null;
    const min = new Date(Math.min(...dates.map((d) => d.getTime())));
    const max = new Date(Math.max(...dates.map((d) => d.getTime())));
    return { min, max };
  }, [memories]);

  const scrubDate = useMemo(() => {
    if (!timeBounds) return null;
    const span = timeBounds.max.getTime() - timeBounds.min.getTime();
    return new Date(timeBounds.min.getTime() + span * timeScrub);
  }, [timeBounds, timeScrub]);

  const filteredMemories = useMemo(() => {
    if (!scrubDate) return memories;
    return memories.filter((mem) => {
      const created = new Date(mem.createdAt);
      return Number.isFinite(created.getTime()) ? created <= scrubDate : true;
    });
  }, [memories, scrubDate]);

  const activeLinks = useMemo(() => links, [links]);

  const visibleLinks = useMemo(() => {
    const idSet = new Set(filteredMemories.map((mem) => mem._id));
    return activeLinks.filter((link) => idSet.has(link.fromId) && idSet.has(link.toId));
  }, [activeLinks, filteredMemories]);

  const linkCounts = useMemo(() => {
    const counts = {};
    visibleLinks.forEach((link) => {
      if (!link.fromId || !link.toId) return;
      counts[link.fromId] = (counts[link.fromId] || 0) + 1;
      counts[link.toId] = (counts[link.toId] || 0) + 1;
    });
    return counts;
  }, [visibleLinks]);

  const formattedScrubDate = useMemo(() => {
    if (!scrubDate) return 'Live';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(scrubDate);
  }, [scrubDate]);

  const allowDrift = activeView === 'CONSTELLATION' && !selectedMemory && !isInteracting;
  const selectedTags = selectedMemory?.tags?.length ? selectedMemory.tags : [];
  const familyOptions = useMemo(() => {
    const set = new Set();
    memories.forEach((mem) => {
      if (mem?.mood) set.add(mem.mood);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [memories]);

  useEffect(() => {
    if (selectedMemory && !filteredMemories.find((mem) => mem._id === selectedMemory._id)) {
      setSelectedMemory(null);
    }
  }, [filteredMemories, selectedMemory]);

  return (
    <div className="v8-shell">
      <div className="v8-canvas">
        <Canvas
          camera={{ position: [0, 0, 70], fov: 35 }}
          onPointerMissed={() => setSelectedMemory(null)}
          style={{ touchAction: 'none' }}
        >
          <color attach="background" args={['#02020b']} />
          <fog attach="fog" args={['#02020b', 25, 300]} />

          <LivingCartography
            memories={filteredMemories}
            onSelect={handleSelect}
            selectedId={selectedMemory?._id}
            showLabels
            links={visibleLinks}
            linkCounts={linkCounts}
          />

          <NebulaClouds />

          <Stars radius={160} depth={90} count={11000} factor={4} saturation={0} fade speed={0.6} />
          <Sparkles count={520} scale={80} size={2.2} speed={0.5} opacity={0.7} />

          {/* UPDATED CAMERA CONTROLS:
            - dollyToCursor={true}: Zooms to where you point (navigation)
            - maxDistance={1200}: Lets you roam far beyond the core cluster
            - truckSpeed={2.2}: Enables faster panning (Right Click Drag)
          */}
          <CameraControls
            ref={setControlsRef}
            makeDefault
            maxDistance={1200}
            minDistance={6}
            dollyToCursor
            smoothTime={0.7}
            dollySpeed={1.1}
            truckSpeed={2.2}
            azimuthRotateSpeed={0.55}
            polarRotateSpeed={0.55}
            onStart={() => setIsInteracting(true)}
            onEnd={() => setIsInteracting(false)}
          />
          <CameraDrift controlsRef={controlsRef} enabled={allowDrift} />

          <EffectComposer disableNormalPass>
            <Bloom luminanceThreshold={0.04} intensity={2.4} radius={0.7} mipmapBlur />
            <Noise opacity={0.06} />
            <ChromaticAberration offset={[0.0012, 0.0012]} />
            <Vignette eskil={false} offset={0.06} darkness={1.05} />
          </EffectComposer>
        </Canvas>
      </div>

      <div className="v8-glow" />
      <div className="v8-aurora" />
      <div className="v8-grid" />
      <div className="v8-vignette" />
      <div className="v8-noise" />

      <div className="v8-overlay">
        <header className="v8-header">
          <div className="v8-brand">
            <div className="v8-kicker">Collective Memory Constellation</div>
            <h1 className="v8-title">The Cloud</h1>
            <p className="v8-subtitle">
              A shared sky of lived moments. Each star is a voice, each line a quiet affinity the archive recognized.
            </p>
          </div>
          <nav className="v8-nav">
            <button
              onClick={() => setActiveView('HOME')}
              className={`v8-pill ${activeView === 'HOME' ? 'is-active' : ''}`}
            >
              Home
            </button>
            <button
              onClick={() => setActiveView('CONSTELLATION')}
              className={`v8-pill ${activeView === 'CONSTELLATION' ? 'is-active' : ''}`}
            >
              Constellation
            </button>
            <button
              onClick={() => setActiveView('SUBMIT')}
              className={`v8-pill ${activeView === 'SUBMIT' ? 'is-active' : ''}`}
            >
              Submit
            </button>
            <button onClick={handleResetView} className="v8-pill">
              Recenter
            </button>
          </nav>
        </header>

        {activeView === 'HOME' && (
          <section className="v8-home">
            <div className="v8-home-card">
              <div className="v8-panel-label">Purpose</div>
              <div className="v8-home-title">A living atlas of shared memory.</div>
              <p className="v8-home-purpose">
                We collect fragments from many lives, let the archive name their moods, and reveal the bonds between
                them. Drift through, find echoes, and add your own light.
              </p>
              <div className="v8-home-actions">
                <button className="v8-primary" onClick={() => setActiveView('CONSTELLATION')}>
                  Enter the Sky
                </button>
                <button className="v8-secondary" onClick={() => setActiveView('SUBMIT')}>
                  Add a Memory
                </button>
              </div>
              <div className="v8-home-note">
                {memories.length} memories • Drag to orbit • Scroll to zoom
              </div>
            </div>
          </section>
        )}

        {activeView === 'CONSTELLATION' && (
          <>
            <div className="v8-meta">
              {filteredMemories.length} memories • Drag to orbit • Right-click to pan • Scroll to fly
            </div>
            <div className="v8-console">
              <div className="v8-console-title">Family Brief</div>
              <select
                className="v8-select"
                value={selectedFamily}
                onChange={(event) => {
                  const mood = event.target.value;
                  setSelectedFamily(mood);
                  handleFamilyBrief(mood);
                }}
              >
                <option value="NONE">Select a family</option>
                {familyOptions.map((mood) => (
                  <option key={mood} value={mood}>
                    {mood}
                  </option>
                ))}
              </select>
              <div className="v8-console-title">Temporal Scrubber</div>
              <input
                className="v8-range"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={timeScrub}
                onChange={(e) => setTimeScrub(Number(e.target.value))}
              />
              <div className="v8-console-date">{formattedScrubDate}</div>
            </div>
            {!memories.length && (
              <div className="v8-empty">
                No memories loaded yet. Start the server or submit your first fragment to light the sky.
              </div>
            )}
            {selectedMemory && (
              <div className="v8-focus">
                <div className="v8-focus-header">
                  <div className="v8-focus-label">{normalizeMood(selectedMemory.mood)}</div>
                  <div className="v8-focus-meta">
                    {selectedMemory.location ? `Origin: ${selectedMemory.location}` : 'Origin: Unknown'}
                  </div>
                </div>
                <div className="v8-focus-text">{selectedMemory.text}</div>
                {selectedTags.length > 0 && (
                  <div className="v8-focus-tags">
                    {selectedTags.slice(0, 6).map((tag) => (
                      <span key={tag} className="v8-focus-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {activeView === 'SUBMIT' && (
          <div className="v8-panel">
            <div className="v8-panel-header">
              <div>
                <div className="v8-panel-label">Submission</div>
                <div className="v8-panel-title">Add your memory to the constellation</div>
              </div>
              <button onClick={() => setActiveView('CONSTELLATION')} className="v8-link-btn">
                Close
              </button>
            </div>

            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Write with intimacy. The archive will classify tone and gravity."
              className="v8-textarea"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleDeposit();
                }
              }}
            />

            <div className="v8-seeds">
              {promptSeeds.map((seed) => (
                <button key={seed} onClick={() => handleSeed(seed)} className="v8-tag">
                  {seed}
                </button>
              ))}
            </div>

            <div className="v8-panel-footer">
              <div className="v8-panel-note">Ctrl/⌘+Enter to transmit</div>
              <button onClick={handleDeposit} disabled={isProcessing} className="v8-primary">
                {isProcessing ? 'Processing...' : 'Transmit'}
              </button>
            </div>
          </div>
        )}

        {toast && (
          <div className="v8-toast">
            <div className="v8-panel-label">Transmission</div>
            <div className={`v8-toast-text ${toast.tone === 'error' ? 'is-error' : ''}`}>{toast.message}</div>
          </div>
        )}

        {(familyBrief || familyBriefStatus === 'loading') && (
          <div className="v8-brief">
            <div className="v8-brief-header">
              <div>
                <div className="v8-panel-label">Family Brief</div>
                <div className="v8-brief-title">{familyBrief?.title || 'Generating brief...'}</div>
              </div>
              <button className="v8-link-btn" onClick={handleBriefClose}>
                Close
              </button>
            </div>
            {familyBriefStatus === 'loading' && <div className="v8-brief-text">Synthesizing the arc...</div>}
            {familyBriefStatus === 'ready' && (
              <>
                <div className="v8-brief-meta">{familyBrief.mood} • {familyBrief.count} memories</div>
                <div className="v8-brief-text">{familyBrief.logline}</div>
                <div className="v8-brief-section">
                  <div className="v8-panel-label">Visual Style</div>
                  <p>{familyBrief.visualStyle}</p>
                </div>
                <div className="v8-brief-section">
                  <div className="v8-panel-label">Soundscape</div>
                  <p>{familyBrief.soundscape}</p>
                </div>
                <div className="v8-brief-section">
                  <div className="v8-panel-label">Director Note</div>
                  <p>{familyBrief.directorNote}</p>
                </div>
              </>
            )}
            {familyBriefStatus === 'error' && (
              <div className="v8-brief-text">Brief unavailable. Try another family.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
