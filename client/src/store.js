import { create } from 'zustand';
import * as THREE from 'three';
import { API_BASE } from './lib/api';

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
  return new THREE.Vector3((rand(1) - 0.5) * 50, (rand(2) - 0.5) * 50, (rand(3) - 0.5) * 50);
}

function hasUsableEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== 3) return false;
  if (!embedding.every((val) => Number.isFinite(val))) return false;
  return embedding.some((val) => Math.abs(val) > 0.0001);
}

export const useStore = create((set, get) => ({
  // VISUAL STATE
  viewMode: 'ORBIT', // ORBIT | FOCUS | SUBMIT | EXHIBITION
  epoch: 0, // 0 = Latest
  
  // DATA STATE
  archive: [],
  clusters: [], // Stores the center points of themes (e.g., "JOY" position)
  selectedNode: null,
  hoveredNode: null,
  
  // ACTIONS
  fetchArchive: async () => {
    try {
      const res = await fetch(`${API_BASE}/memories`);
      const data = await res.json();
      
      // PROCESS DATA: Map MongoDB to 3D Space
      const processed = data.map((mem) => {
        const position = hasUsableEmbedding(mem.embedding)
          ? new THREE.Vector3(mem.embedding[0] * 50, mem.embedding[1] * 50, mem.embedding[2] * 50)
          : seededPosition(mem._id || mem.text || 'seed');

        return {
          ...mem,
          position,
          // Extract Month/Year for Epochs
          timestamp: new Date(mem.createdAt).getTime()
        };
      });

      // CALCULATE CLUSTER CENTROIDS (For Labels)
      const uniqueMoods = [...new Set(processed.map(p => p.mood))];
      const clusterData = uniqueMoods.map(mood => {
        const nodes = processed.filter(p => p.mood === mood);
        if (nodes.length === 0) return null;
        
        // Find average position
        const center = new THREE.Vector3();
        nodes.forEach(n => center.add(n.position));
        center.divideScalar(nodes.length);
        
        return { name: mood, position: center, count: nodes.length };
      }).filter(Boolean);

      set({ archive: processed, clusters: clusterData });
      
    } catch (e) {
      console.error("Failed to connect to Neural Core:", e);
    }
  },
  
  setHovered: (node) => set({ hoveredNode: node }),
  selectNode: (node) => set({ selectedNode: node, viewMode: node ? 'FOCUS' : 'ORBIT' }),
  setMode: (mode) => set({ viewMode: mode }),
  setEpoch: (val) => set({ epoch: val }),
}));
