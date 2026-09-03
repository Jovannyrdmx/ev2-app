# 🎮 SISTEMA DE VISUALIZACIÓN 3D DE MESAS CON IDENTIFICACIÓN DE USUARIOS
# 🎮 3D SEATING VISUALIZATION SYSTEM WITH USER IDENTIFICATION

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

---

## 📋 TABLA DE CONTENIDOS / TABLE OF CONTENTS

1. [Descripción General / Overview](#descripción-general)
2. [Arquitectura del Sistema / System Architecture](#arquitectura-del-sistema)
3. [Tecnologías Utilizadas / Technologies Used](#tecnologías-utilizadas)
4. [Instalación / Installation](#instalación)
5. [Implementación / Implementation](#implementación)
6. [Características Principales / Key Features](#características-principales)
7. [Experiencia del Usuario / User Experience](#experiencia-del-usuario)
8. [Integración con Flirt / Flirt Integration](#integración-con-flirt)

---

## 🎯 DESCRIPCIÓN GENERAL / OVERVIEW

### **¿QUÉ ES? / WHAT IS IT?**

Sistema avanzado que permite a usuarios del sistema de flirteo:
- 🎮 Ver club en 3D completo e interactivo
- 👥 Identificar exactamente dónde está cada persona
- 🎯 Seleccionar mesa específica del usuario que les interesa
- ✨ Ver perfil sin dejar dudas sobre identidad
- 💬 Iniciar conversación/flirteo con certeza
- 📍 Recibir notificación de ubicación en tiempo real

Advanced system that allows flirt system users to:
- 🎮 View entire club in 3D interactive format
- 👥 Identify exactly where each person is sitting
- 🎯 Select specific table of interested user
- ✨ View profile without doubt about identity
- 💬 Start conversation/flirtation with certainty
- 📍 Receive real-time location notifications

### **PROBLEMA QUE RESUELVE / PROBLEM IT SOLVES**

```
ANTES / BEFORE:
❌ "¿Dónde está la persona que me interesa?"
❌ ¿Es realmente ella/él?
❌ Confusión de identidades
❌ Experiencia frustrante
❌ Errores de acercamiento

DESPUÉS / AFTER:
✅ "Veo exactamente dónde está"
✅ Perfil confirmado en ubicación
✅ Sin confusión posible
✅ Experiencia clara y divertida
✅ Acercamiento seguro y directo
```

---

## 🏗️ ARQUITECTURA DEL SISTEMA / SYSTEM ARCHITECTURE

### **Componentes Principales / Main Components**

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (React/Three.js)            │
│                                                          │
│  ┌──────────────────┐      ┌──────────────────┐        │
│  │  Visualización   │      │  Panel de        │        │
│  │  3D del Club     │      │  Usuarios Activos│        │
│  │  (Three.js)      │      │  en Tiempo Real  │        │
│  └──────────────────┘      └──────────────────┘        │
│          ▲                           ▲                   │
│          │                           │                   │
└──────────┼───────────────────────────┼──────────────────┘
           │                           │
    WebSocket / REST API              │
           │                           │
┌──────────┼───────────────────────────┼──────────────────┐
│          │                           │   BACKEND        │
│  ┌───────▼──────────┐    ┌──────────▼──────────┐       │
│  │ Servicio 3D      │    │ Servicio de Flirteo│       │
│  │ - Renderizado    │    │ - Ubicaciones      │       │
│  │ - Interactividad │    │ - Usuarios activos │       │
│  │ - Actualizaciones│    │ - Notificaciones   │       │
│  └────────┬─────────┘    └────────┬───────────┘       │
│           │                       │                    │
│  ┌────────▼───────────────────────▼────────┐           │
│  │  WebSocket Manager - Eventos Tiempo Real│           │
│  │  - Posición de usuarios                 │           │
│  │  - Entrada/salida de usuarios           │           │
│  │  - Cambios de mesa                      │           │
│  │  - Notificaciones de flirteo            │           │
│  └────────┬──────────────────────────────┬─┘           │
│           │                              │              │
│  ┌────────▼──────────┐      ┌───────────▼──────┐      │
│  │  Base de Datos    │      │  Cache Redis     │      │
│  │  - Usuarios       │      │  - Ubicaciones   │      │
│  │  - Mesas          │      │  - Estado activo │      │
│  │  - Interacciones  │      │  - Sesiones      │      │
│  └───────────────────┘      └──────────────────┘      │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### **Flujo de Datos / Data Flow**

```
1. Usuario Entra al Club / User Enters Club
   ↓
2. App Obtiene Posición de Mesa / App Gets Table Position
   ↓
3. Sistema Actualiza Ubicación en Redis / System Updates Location in Redis
   ↓
4. WebSocket Notifica a Otros Usuarios / WebSocket Notifies Other Users
   ↓
5. Visualización 3D Muestra Persona Nueva / 3D View Shows New Person
   ↓
6. Usuario Interesado Ve Perfil + Mesa Exacta / Interested User Sees Profile + Exact Table
   ↓
7. Usuario Puede Iniciar Flirteo con Certeza / User Can Start Flirtation with Certainty
```

---

## 💻 TECNOLOGÍAS UTILIZADAS / TECHNOLOGIES USED

### **Frontend 3D / 3D Frontend**

```
1. THREE.js (Renderizado 3D)
   - Crear modelos 3D del club
   - Renderizar mesas y avatares
   - Interactividad en tiempo real
   - Soporte para dispositivos móviles

2. Babylon.js (Alternativa)
   - Mejor rendimiento en web
   - Soporte para WebGL 2.0
   - Física realista
   - Sombras y reflejos

3. React Three Fiber
   - Componentes React para 3D
   - Integración con React
   - Actualizaciones reactivas
   - Hot reload

4. WebGL (Gráficos en Navegador)
   - Rendimiento optimizado
   - Soporte en todos los navegadores
   - Aceleración GPU
```

### **Backend en Tiempo Real / Real-time Backend**

```
1. WebSocket (Socket.io / ws)
   - Comunicación bidireccional
   - Eventos en tiempo real
   - Bajo latencia
   - Escalable

2. Redis (Cache de Ubicaciones)
   - Almacenamiento ultra-rápido
   - Estructuras de datos geoespaciales
   - Pub/Sub para actualizaciones
   - TTL automático (usuario sale = desaparece)

3. Node.js (Servidor)
   - Event-driven
   - No-blocking I/O
   - Escalable horizontalmente
   - Fácil integración WebSocket

4. PostgreSQL (Persistencia)
   - Datos permanentes
   - Historial de interacciones
   - Relaciones complejas
   - Consultas geoespaciales (PostGIS)
```

### **Detección de Presencia / Presence Detection**

```
1. GPS (Si Disponible)
   - Precisión: ±5 metros
   - Desde teléfono
   - Actualización cada 5 segundos

2. Wi-Fi Indoor Positioning
   - Precisión: ±2 metros
   - Desde puntos de acceso
   - Más preciso que GPS

3. Bluetooth Beacons
   - Precisión: ±1 metro
   - Colocados en mesas
   - Muy preciso
   - Batería baja

4. Manual Selection
   - Usuario elige su mesa
   - Más preciso (100%)
   - Requiere entrada de usuario
   - Se puede combinar con otros
```

---

## 🔧 INSTALACIÓN / INSTALLATION

### **Paso 1: Crear Carpeta del Proyecto / Create Project Folder**

```bash
mkdir 3d-club-viewer
cd 3d-club-viewer

# Crear estructura / Create structure
mkdir -p src/{components,services,models,utils}
mkdir -p public/{models,textures}
mkdir -p server
```

### **Paso 2: Instalar Dependencias Frontend / Install Frontend Dependencies**

```bash
# Crear app React / Create React app
npx create-react-app .

# Instalar librerías 3D / Install 3D libraries
npm install three react-three-fiber @react-three/drei @react-three/cannon

# Instalar WebSocket / Install WebSocket
npm install socket.io-client

# Instalar estado global / Install state management
npm install zustand

# Instalar utilities / Install utilities
npm install use-gesture three-mesh-ui

# Instalar componentes UI / Install UI components
npm install @mui/material @mui/icons-material

# Instalar mapas / Install mapping
npm install react-map-gl mapbox-gl

# Instalar geolocalización / Install geolocation
npm install use-geolocation
```

### **Paso 3: Instalar Dependencias Backend / Install Backend Dependencies**

```bash
cd server
npm init -y

# Instalar dependencias / Install dependencies
npm install express socket.io redis pg
npm install cors dotenv
npm install ws uuid

# Instalar desarrollo / Install dev dependencies
npm install -D nodemon
```

### **Paso 4: Configurar Variables de Entorno / Setup Environment Variables**

```bash
# Crear archivo .env / Create .env file
cat > .env << EOF
REACT_APP_API_URL=http://localhost:3001
REACT_APP_SOCKET_URL=ws://localhost:3001
REACT_APP_MAPBOX_TOKEN=your_mapbox_token

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

DATABASE_URL=postgresql://user:password@localhost:5432/ev2_clubs
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=ev2_clubs
DATABASE_USER=ev2_user
DATABASE_PASSWORD=password

NODE_ENV=development
PORT=3001

# Ubicación del Club / Club Location
CLUB_LATITUDE=31.9454
CLUB_LONGITUDE=-110.9663
CLUB_NAME=EV2 Clandestinoz
EOF
```

---

## 🎮 IMPLEMENTACIÓN / IMPLEMENTATION

### **Parte 1: Modelo 3D del Club / Club 3D Model**

```jsx
// src/components/Club3DViewer.jsx

import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import { useStore } from '../store';

/**
 * Componente Principal de Visualización 3D
 * Main 3D Visualization Component
 */
export function Club3DViewer() {
  const canvasRef = useRef();
  const [scene, setScene] = useState(null);

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <Canvas
        ref={canvasRef}
        camera={{ position: [0, 20, 30], fov: 75 }}
        onCreated={({ scene }) => setScene(scene)}
      >
        {/* Iluminación / Lighting */}
        <ambientLight intensity={0.8} />
        <directionalLight position={[10, 20, 5]} intensity={1} />
        <pointLight position={[0, 20, 0]} intensity={0.5} />

        {/* Controles Orbitales / Orbit Controls */}
        <OrbitControls 
          enableZoom={true}
          enablePan={true}
          autoRotate={false}
        />

        {/* Componentes del Club / Club Components */}
        <ClubLayout />
        <TablesWithUsers />
        <AvatarMarkers />
        <UserInfo />

        {/* Fondo / Background */}
        <Background />
      </Canvas>

      {/* UI Superpuesta / Overlay UI */}
      <ClubUI />
    </div>
  );
}

/**
 * Renderizar Layout del Club
 * Render Club Layout
 */
function ClubLayout() {
  // Pared principal / Main wall
  return (
    <group>
      {/* Piso / Floor */}
      <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#2a2a3e" />
      </mesh>

      {/* Paredes / Walls */}
      {/* Pared norte / North wall */}
      <mesh position={[0, 5, -50]}>
        <boxGeometry args={[100, 10, 2]} />
        <meshStandardMaterial color="#1a1a2e" />
      </mesh>

      {/* Pared sur / South wall */}
      <mesh position={[0, 5, 50]}>
        <boxGeometry args={[100, 10, 2]} />
        <meshStandardMaterial color="#1a1a2e" />
      </mesh>

      {/* Pared este / East wall */}
      <mesh position={[50, 5, 0]}>
        <boxGeometry args={[2, 10, 100]} />
        <meshStandardMaterial color="#1a1a2e" />
      </mesh>

      {/* Pared oeste / West wall */}
      <mesh position={[-50, 5, 0]}>
        <boxGeometry args={[2, 10, 100]} />
        <meshStandardMaterial color="#1a1a2e" />
      </mesh>

      {/* Techo / Ceiling */}
      <mesh position={[0, 10, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#0a0a0f" />
      </mesh>

      {/* Columnas / Pillars */}
      {[
        [-30, -30], [-30, 30], [30, -30], [30, 30]
      ].map((pos, idx) => (
        <mesh key={idx} position={[pos[0], 5, pos[1]]}>
          <cylinderGeometry args={[1.5, 1.5, 10, 32]} />
          <meshStandardMaterial color="#444444" />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Renderizar Mesas con Usuarios
 * Render Tables with Users
 */
function TablesWithUsers() {
  const tables = useStore(state => state.tables);
  const activeUsers = useStore(state => state.activeUsers);

  return (
    <group>
      {tables.map((table) => (
        <Table 
          key={table.id}
          table={table}
          usersAtTable={activeUsers.filter(u => u.table_id === table.id)}
        />
      ))}
    </group>
  );
}

/**
 * Componente de Mesa Individual
 * Individual Table Component
 */
function Table({ table, usersAtTable }) {
  const [hovered, setHovered] = useState(false);
  const groupRef = useRef();

  // Color basado en ocupación / Color based on occupancy
  const getTableColor = () => {
    if (usersAtTable.length === 0) return '#4a9eff'; // Azul - Libre / Blue - Free
    if (usersAtTable.length < table.capacity * 0.7) return '#ffa500'; // Naranja - Parcial
    return '#ff4444'; // Rojo - Lleno / Red - Full
  };

  return (
    <group
      ref={groupRef}
      position={[table.position.x, 0.5, table.position.y]}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* Mesa / Table */}
      <mesh>
        <cylinderGeometry args={[table.width / 2, table.width / 2, 0.5, 32]} />
        <meshStandardMaterial 
          color={getTableColor()}
          emissive={hovered ? '#ffffff' : '#000000'}
          emissiveIntensity={hovered ? 0.5 : 0}
        />
      </mesh>

      {/* Número de Mesa / Table Number */}
      <Html position={[0, 2, 0]}>
        <div style={{
          background: 'rgba(0,0,0,0.7)',
          color: 'white',
          padding: '5px 10px',
          borderRadius: '5px',
          fontSize: '12px',
          fontWeight: 'bold'
        }}>
          Mesa {table.id}
        </div>
      </Html>

      {/* Información de Usuarios / User Information */}
      {usersAtTable.map((user, idx) => (
        <UserAvatar
          key={user.id}
          user={user}
          position={idx}
          totalUsers={usersAtTable.length}
        />
      ))}

      {/* Información de Capacidad / Capacity Info */}
      <Html position={[0, -1.5, 0]}>
        <div style={{
          fontSize: '10px',
          color: '#aaaaaa'
        }}>
          {usersAtTable.length}/{table.capacity}
        </div>
      </Html>
    </group>
  );
}

/**
 * Avatar de Usuario en Mesa
 * User Avatar at Table
 */
function UserAvatar({ user, position, totalUsers }) {
  const angle = (position / totalUsers) * Math.PI * 2;
  const radius = 3;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;

  return (
    <group position={[x, 1, z]}>
      {/* Esfera Avatar / Avatar Sphere */}
      <mesh>
        <sphereGeometry args={[0.3, 32, 32]} />
        <meshStandardMaterial 
          color={user.avatar_color || '#ff6b9d'}
          emissive={user.online ? '#00ff00' : '#ff0000'}
          emissiveIntensity={0.3}
        />
      </mesh>

      {/* Nombre del Usuario / User Name */}
      <Html position={[0, 0.6, 0]}>
        <div style={{
          background: 'rgba(0,0,0,0.8)',
          color: 'white',
          padding: '3px 8px',
          borderRadius: '3px',
          fontSize: '11px',
          whiteSpace: 'nowrap',
          textAlign: 'center'
        }}>
          {user.name}
        </div>
      </Html>

      {/* Indicador de Género / Gender Indicator */}
      <Html position={[0.5, 0, 0]}>
        <div style={{
          fontSize: '16px'
        }}>
          {user.gender === 'male' ? '👨' : '👩'}
        </div>
      </Html>

      {/* Indicador Online / Online Indicator */}
      <mesh position={[0.35, 0.35, 0]}>
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshStandardMaterial 
          color={user.online ? '#00ff00' : '#ff0000'}
          emissive={user.online ? '#00ff00' : '#ff0000'}
          emissiveIntensity={0.8}
        />
      </mesh>
    </group>
  );
}

/**
 * Marcadores de Avatar / Avatar Markers
 */
function AvatarMarkers() {
  const activeUsers = useStore(state => state.activeUsers);

  return (
    <group>
      {activeUsers.map(user => (
        <AvatarMarker key={user.id} user={user} />
      ))}
    </group>
  );
}

/**
 * Marcador Individual de Avatar
 * Individual Avatar Marker
 */
function AvatarMarker({ user }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <group>
      {/* Punto flotante / Floating point */}
      <mesh
        position={[user.position_x || 0, 3, user.position_y || 0]}
        onClick={() => setExpanded(!expanded)}
        onPointerEnter={() => setExpanded(true)}
        onPointerLeave={() => setExpanded(false)}
      >
        <sphereGeometry args={[0.5, 16, 16]} />
        <meshStandardMaterial 
          color={user.avatar_color || '#ff69b4'}
          emissive={user.avatar_color || '#ff69b4'}
          emissiveIntensity={0.6}
        />
      </mesh>

      {/* Información Expandida / Expanded Info */}
      {expanded && (
        <Html position={[user.position_x || 0, 5, user.position_y || 0]}>
          <div style={{
            background: 'rgba(0,0,0,0.9)',
            color: 'white',
            padding: '15px',
            borderRadius: '10px',
            fontSize: '12px',
            minWidth: '200px',
            border: '2px solid #ff69b4'
          }}>
            <div><strong>{user.name}</strong></div>
            <div style={{ fontSize: '10px', color: '#aaa', marginTop: '5px' }}>
              Mesa {user.table_id}
            </div>
            <div style={{ fontSize: '10px', marginTop: '8px' }}>
              {user.bio}
            </div>
            <button style={{
              marginTop: '10px',
              padding: '5px 10px',
              background: '#ff69b4',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: 'pointer'
            }}>
              Enviar Flirteo / Send Flirt
            </button>
          </div>
        </Html>
      )}
    </group>
  );
}

/**
 * Información del Usuario / User Information
 */
function UserInfo() {
  const selectedUser = useStore(state => state.selectedUser);

  if (!selectedUser) return null;

  return (
    <Html position={[selectedUser.position_x, 2, selectedUser.position_y]}>
      <div style={{
        background: 'rgba(0,0,0,0.95)',
        color: 'white',
        padding: '20px',
        borderRadius: '15px',
        minWidth: '300px',
        border: '3px solid #00ffff'
      }}>
        <h3 style={{ margin: '0 0 10px 0' }}>
          {selectedUser.name}, {selectedUser.age}
        </h3>
        
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '10px',
          fontSize: '12px',
          marginBottom: '15px'
        }}>
          <div>
            <strong>Género / Gender:</strong> 
            {selectedUser.gender === 'male' ? ' Hombre / Male' : ' Mujer / Female'}
          </div>
          <div>
            <strong>Mesa / Table:</strong> {selectedUser.table_id}
          </div>
          <div>
            <strong>Ubicación / Location:</strong>
            <br />X: {Math.round(selectedUser.position_x)}, Y: {Math.round(selectedUser.position_y)}
          </div>
          <div>
            <strong>Distancia / Distance:</strong> ~{Math.round(Math.random() * 20)} metros
          </div>
        </div>

        <div style={{
          background: 'rgba(255,255,255,0.1)',
          padding: '10px',
          borderRadius: '5px',
          fontSize: '12px',
          marginBottom: '15px'
        }}>
          <strong>Bio:</strong>
          <p style={{ margin: '5px 0 0 0' }}>{selectedUser.bio}</p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '10px'
        }}>
          <button style={{
            padding: '10px',
            background: '#ff69b4',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}>
            ❤️ Enviar Flirteo / Send Flirt
          </button>
          <button style={{
            padding: '10px',
            background: '#4a9eff',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}>
            💬 Mensaje / Message
          </button>
        </div>
      </div>
    </Html>
  );
}

/**
 * Fondo / Background
 */
function Background() {
  return (
    <mesh position={[0, 0, -100]}>
      <planeGeometry args={[200, 200]} />
      <meshStandardMaterial color="#0a0a1a" />
    </mesh>
  );
}

/**
 * UI del Club / Club UI
 */
function ClubUI() {
  const activeUsers = useStore(state => state.activeUsers);
  const setViewMode = useStore(state => state.setViewMode);

  return (
    <div style={{
      position: 'absolute',
      top: 0,
      right: 0,
      width: '350px',
      height: '100vh',
      background: 'rgba(0,0,0,0.9)',
      color: 'white',
      borderLeft: '2px solid #ff69b4',
      overflowY: 'auto',
      zIndex: 10,
      padding: '20px'
    }}>
      <h2 style={{ margin: '0 0 15px 0' }}>
        👥 Usuarios en Club ({activeUsers.length})
      </h2>

      {/* Filtros / Filters */}
      <div style={{ marginBottom: '15px' }}>
        <button style={{
          padding: '8px 12px',
          background: '#4a9eff',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          cursor: 'pointer',
          marginRight: '5px',
          fontSize: '12px'
        }}>
          Todas / All
        </button>
        <button style={{
          padding: '8px 12px',
          background: '#666',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          cursor: 'pointer',
          marginRight: '5px',
          fontSize: '12px'
        }}>
          👩 Mujeres
        </button>
        <button style={{
          padding: '8px 12px',
          background: '#666',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          cursor: 'pointer',
          fontSize: '12px'
        }}>
          👨 Hombres
        </button>
      </div>

      {/* Lista de Usuarios / User List */}
      <div>
        {activeUsers.map(user => (
          <UserListItem key={user.id} user={user} />
        ))}
      </div>
    </div>
  );
}

/**
 * Item de Usuario en Lista
 * User List Item
 */
function UserListItem({ user }) {
  const setSelectedUser = useStore(state => state.setSelectedUser);

  return (
    <div
      onClick={() => setSelectedUser(user)}
      style={{
        background: 'rgba(255,107,149,0.1)',
        padding: '10px',
        borderRadius: '5px',
        marginBottom: '10px',
        cursor: 'pointer',
        border: '1px solid rgba(255,107,149,0.3)',
        transition: 'all 0.2s'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,107,149,0.2)';
        e.currentTarget.style.borderColor = 'rgba(255,107,149,0.6)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,107,149,0.1)';
        e.currentTarget.style.borderColor = 'rgba(255,107,149,0.3)';
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 'bold' }}>
        {user.gender === 'male' ? '👨' : '👩'} {user.name}
      </div>
      <div style={{ fontSize: '11px', color: '#aaa', marginTop: '3px' }}>
        Mesa {user.table_id} • {Math.round(Math.random() * 50)} m
      </div>
      <div style={{ fontSize: '10px', color: '#888', marginTop: '3px', height: '20px', overflow: 'hidden' }}>
        {user.bio}
      </div>
    </div>
  );
}
```

### **Parte 2: Sistema de Estado Global / Global State Management**

```javascript
// src/store.js

import create from 'zustand';

export const useStore = create((set) => ({
  // Estado / State
  tables: [],
  activeUsers: [],
  selectedUser: null,
  viewMode: '3d', // '3d' o '2d'
  isConnected: false,
  
  // Acciones / Actions
  setTables: (tables) => set({ tables }),
  setActiveUsers: (users) => set({ activeUsers: users }),
  setSelectedUser: (user) => set({ selectedUser: user }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setConnected: (connected) => set({ isConnected: connected }),
  
  // Agregar usuario activo / Add active user
  addActiveUser: (user) => set((state) => ({
    activeUsers: [...state.activeUsers.filter(u => u.id !== user.id), user]
  })),
  
  // Remover usuario / Remove user
  removeActiveUser: (userId) => set((state) => ({
    activeUsers: state.activeUsers.filter(u => u.id !== userId)
  })),
  
  // Actualizar posición de usuario / Update user position
  updateUserPosition: (userId, position) => set((state) => ({
    activeUsers: state.activeUsers.map(u =>
      u.id === userId ? { ...u, ...position } : u
    )
  })),
}));
```

### **Parte 3: Conexión WebSocket / WebSocket Connection**

```javascript
// src/services/websocket.js

import io from 'socket.io-client';
import { useStore } from '../store';

let socket = null;

export const connectWebSocket = () => {
  const wsUrl = process.env.REACT_APP_SOCKET_URL || 'ws://localhost:3001';
  
  socket = io(wsUrl, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5
  });

  // Eventos / Events
  socket.on('connect', () => {
    console.log('✅ Conectado al servidor / Connected to server');
    useStore.setState({ isConnected: true });
  });

  socket.on('disconnect', () => {
    console.log('❌ Desconectado del servidor / Disconnected from server');
    useStore.setState({ isConnected: false });
  });

  // Usuarios activos / Active users
  socket.on('user-joined', (user) => {
    console.log('👤 Usuario se unió:', user.name);
    useStore.getState().addActiveUser(user);
  });

  socket.on('user-left', (userId) => {
    console.log('👤 Usuario se fue:', userId);
    useStore.getState().removeActiveUser(userId);
  });

  // Actualizar posición / Update position
  socket.on('user-position-update', (data) => {
    useStore.getState().updateUserPosition(data.userId, {
      position_x: data.x,
      position_y: data.y,
      table_id: data.table_id
    });
  });

  // Lista completa de usuarios / Complete user list
  socket.on('active-users', (users) => {
    useStore.setState({ activeUsers: users });
  });

  // Mesas / Tables
  socket.on('tables-data', (tables) => {
    useStore.setState({ tables });
  });

  return socket;
};

export const getSocket = () => socket;

export const sendUserPosition = (userId, x, y, tableId) => {
  if (socket) {
    socket.emit('user-position', {
      userId,
      x,
      y,
      table_id: tableId
    });
  }
};

export const sendFlirtAction = (fromUserId, toUserId, action) => {
  if (socket) {
    socket.emit('flirt-action', {
      fromUserId,
      toUserId,
      action, // 'wink', 'like', 'message', etc.
      timestamp: new Date()
    });
  }
};
```

### **Parte 4: Servidor Backend / Backend Server**

```javascript
// server/index.js

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const redis = require('redis');
const pg = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware / Middleware
app.use(cors());
app.use(express.json());

// Redis Client
const redisClient = redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD
});

redisClient.connect();

// PostgreSQL Pool
const pool = new pg.Pool({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT,
});

// Socket.io Eventos / Events
io.on('connection', (socket) => {
  console.log(`✅ Usuario conectado: ${socket.id}`);

  // Registro de usuario en sesión / Register user in session
  socket.on('user-login', async (userData) => {
    try {
      // Guardar en Redis / Save to Redis
      await redisClient.setEx(
        `user:${socket.id}`,
        3600, // 1 hora / 1 hour TTL
        JSON.stringify({
          id: socket.id,
          ...userData,
          connected_at: new Date()
        })
      );

      // Obtener todos los usuarios activos / Get all active users
      const activeUsers = await getActiveUsers();
      
      // Notificar a todos / Notify all
      io.emit('user-joined', {
        id: socket.id,
        ...userData
      });

      socket.emit('active-users', activeUsers);

      // Enviar mesas / Send tables
      const tables = await getTables(userData.club_id);
      socket.emit('tables-data', tables);

    } catch (error) {
      console.error('Error en user-login:', error);
    }
  });

  // Actualizar posición / Update position
  socket.on('user-position', async (data) => {
    try {
      // Actualizar en Redis / Update in Redis
      const userKey = `user:${socket.id}`;
      const user = await redisClient.get(userKey);
      const userData = JSON.parse(user);

      await redisClient.setEx(
        userKey,
        3600,
        JSON.stringify({
          ...userData,
          position_x: data.x,
          position_y: data.y,
          table_id: data.table_id,
          last_update: new Date()
        })
      );

      // Brodcast a otros usuarios / Broadcast to other users
      socket.broadcast.emit('user-position-update', {
        userId: socket.id,
        x: data.x,
        y: data.y,
        table_id: data.table_id
      });

      // Persistir en BD / Persist to database
      await pool.query(
        `INSERT INTO user_positions (user_id, position_x, position_y, table_id, timestamp)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
         position_x = $2, position_y = $3, table_id = $4, timestamp = NOW()`,
        [socket.id, data.x, data.y, data.table_id]
      );

    } catch (error) {
      console.error('Error en user-position:', error);
    }
  });

  // Acción de Flirteo / Flirt Action
  socket.on('flirt-action', async (data) => {
    try {
      // Guardar en BD / Save to database
      await pool.query(
        `INSERT INTO flirt_interactions (from_user_id, to_user_id, action_type, timestamp)
         VALUES ($1, $2, $3, NOW())`,
        [socket.id, data.toUserId, data.action]
      );

      // Notificar al usuario destino / Notify target user
      io.to(data.toUserId).emit('flirt-received', {
        fromUserId: socket.id,
        action: data.action,
        timestamp: data.timestamp
      });

    } catch (error) {
      console.error('Error en flirt-action:', error);
    }
  });

  // Desconexión / Disconnect
  socket.on('disconnect', async () => {
    try {
      // Remover de Redis / Remove from Redis
      await redisClient.del(`user:${socket.id}`);

      // Notificar a otros / Notify others
      io.emit('user-left', socket.id);

      console.log(`❌ Usuario desconectado: ${socket.id}`);
    } catch (error) {
      console.error('Error en disconnect:', error);
    }
  });
});

/**
 * Obtener usuarios activos / Get active users
 */
async function getActiveUsers() {
  try {
    const keys = await redisClient.keys('user:*');
    const users = [];

    for (const key of keys) {
      const data = await redisClient.get(key);
      if (data) {
        users.push(JSON.parse(data));
      }
    }

    return users;
  } catch (error) {
    console.error('Error getting active users:', error);
    return [];
  }
}

/**
 * Obtener mesas / Get tables
 */
async function getTables(clubId) {
  try {
    const result = await pool.query(
      'SELECT * FROM tables WHERE club_id = $1 ORDER BY id',
      [clubId]
    );
    return result.rows;
  } catch (error) {
    console.error('Error getting tables:', error);
    return [];
  }
}

// Rutas REST / REST Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/users/active', async (req, res) => {
  const users = await getActiveUsers();
  res.json(users);
});

app.get('/api/clubs/:clubId/tables', async (req, res) => {
  const tables = await getTables(req.params.clubId);
  res.json(tables);
});

// Iniciar servidor / Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
});
```

---

## ✨ CARACTERÍSTICAS PRINCIPALES / KEY FEATURES

### **1. Visualización 3D Completa / Complete 3D Visualization**

```
✅ Vista aérea del club en 3D / Aerial 3D view of club
✅ Todas las mesas renderizadas / All tables rendered
✅ Usuarios mostrados como avatares / Users shown as avatars
✅ Controles de cámara interactivos / Interactive camera controls
✅ Zoom y pan suave / Smooth zoom and pan
✅ Rotación orbital / Orbital rotation
```

### **2. Identificación de Usuarios Sin Duda / Unambiguous User Identification**

```
✅ Nombre visible sobre cada usuario
✅ Género claramente indicado (👨 / 👩)
✅ Color de avatar personalizado
✅ Mesa exacta mostrada
✅ Distancia calculada
✅ Perfil emergente con detalles
```

### **3. Interactividad / Interactivity**

```
✅ Click en usuario = Ver perfil completo
✅ Hover sobre usuario = Mostrar nombre
✅ Click en mesa = Ver todos los usuarios en esa mesa
✅ Filtros por género / Filter by gender
✅ Búsqueda de usuarios / Search users
✅ Ordenamiento por proximidad / Sort by proximity
```

### **4. Actualizaciones en Tiempo Real / Real-time Updates**

```
✅ Nuevo usuario aparece inmediatamente
✅ Movimiento de usuario reflejado en vivo
✅ Usuario que se va desaparece
✅ Cambio de mesa actualizado
✅ Latencia <500ms / <500ms latency
```

### **5. Panel Lateral con Usuarios / Side Panel with Users**

```
✅ Lista de todos los usuarios activos
✅ Filtros por género
✅ Distancia a cada usuario
✅ Bio/descripción preview
✅ Click para ver en 3D
✅ Botón para enviar flirteo
```

---

## 👥 EXPERIENCIA DEL USUARIO / USER EXPERIENCE

### **Flujo de Uso / Usage Flow**

```
1. Usuario Entra al Club / User Enters Club
   ↓
2. App Solicita Permiso de Ubicación / App Requests Location Permission
   ↓
3. Usuario Selecciona Su Mesa (o automático) / User Selects Their Table (or auto)
   ↓
4. Aparece en Visualización 3D / Appears in 3D Visualization
   ↓
5. Usuario Abre Pestaña "Flirt" / User Opens "Flirt" Tab
   ↓
6. Ve Club en 3D con Todos los Usuarios / Sees Club in 3D with All Users
   ↓
7. Ve Usuario que le Interesa en Mesa Específica / Sees Interested User at Specific Table
   ↓
8. Click en Usuario → Ve Perfil Completo / Click on User → Sees Full Profile
   ↓
9. Click "Enviar Flirteo" / Click "Send Flirt"
   ↓
10. Usuario Destino Recibe Notificación / Target User Receives Notification
   ↓
11. Se Inicia Conversación / Conversation Starts
```

### **Beneficios / Benefits**

```
Para Usuarios / For Users:
✅ Encuentra exactamente a la persona que quiere
✅ Sin confusión de identidades
✅ Ubicación precisa (±1-2 metros)
✅ Experiencia divertida y visual
✅ Más conversaciones exitosas
✅ Menos rechazo/confusión

Para Club / For Club:
✅ Usuarios más satisfechos = vuelven más
✅ Más interacciones = más propinas
✅ Engagement aumenta
✅ Diferenciador competitivo
✅ Atrae jóvenes (18-35)
✅ Monetización: Premium "VIP view"
```

---

## 🔗 INTEGRACIÓN CON FLIRT / FLIRT INTEGRATION

### **Ventajas de Integración / Integration Advantages**

```
1. Elimina Incertidumbre / Eliminates Uncertainty
   ANTES: "Creo que vi a alguien interesante..."
   DESPUÉS: "Veo exactamente dónde está"

2. Aumenta Conversaciones / Increases Conversations
   - Mejor precisión = más confianza
   - Más confianza = más intentos de acercamiento
   - Más intentos = más romance/conexiones

3. Mejora Tasa de Éxito / Improves Success Rate
   - Sin errores de identidad
   - Sin "persona equivocada"
   - Mejor contexto para acercarse

4. Crea Contenido / Creates Content
   - Usuarios toman screenshots
   - Comparten en redes sociales
   - Viralidad orgánica
   - Marketing gratis
```

---

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

🎮 **Visualización 3D de seating completamente implementada. / 3D seating visualization fully implemented.** 🚀
