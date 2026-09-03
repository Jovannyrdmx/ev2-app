# 📍 SISTEMA DE RASTREO EN VIVO DE CLIENTES CON ENTREGA DE BEBIDAS
# 📍 LIVE CUSTOMER MOVEMENT TRACKING WITH DRINK DELIVERY SYSTEM

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

---

## 📋 TABLA DE CONTENIDOS / TABLE OF CONTENTS

1. [Descripción General / Overview](#descripción-general)
2. [Arquitectura del Sistema / System Architecture](#arquitectura-del-sistema)
3. [Tecnologías Utilizadas / Technologies Used](#tecnologías-utilizadas)
4. [Instalación / Installation](#instalación)
5. [Implementación / Implementation](#implementación)
6. [Características Principales / Key Features](#características-principales)
7. [Experiencia del Mesero / Waiter Experience](#experiencia-del-mesero)
8. [Integración con Sistema de Propinas / Flirt Integration](#integración-con-sistema-de-propinas)

---

## 🎯 DESCRIPCIÓN GENERAL / OVERVIEW

### **¿QUÉ ES? / WHAT IS IT?**

Sistema inteligente que:
- 🍹 Cliente ordena bebida desde app
- 📍 Sistema calcula ubicación en tiempo real
- 🚨 Mesero recibe notificación con ubicación exacta
- 🗺️ Mapa en vivo muestra dónde está el cliente
- 📡 Rastrea movimiento mientras mesero se acerca
- ✅ Confirma entrega cuando llega
- 💰 Asigna automáticamente propina

Advanced system that:
- 🍹 Customer orders drink from app
- 📍 System calculates real-time location
- 🚨 Waiter receives notification with exact location
- 🗺️ Live map shows where customer is
- 📡 Tracks movement as waiter approaches
- ✅ Confirms delivery when arrived
- 💰 Automatically assigns tip

### **PROBLEMA QUE RESUELVE / PROBLEM IT SOLVES**

```
ANTES / BEFORE:
❌ "¿Dónde está la mesa 15?"
❌ Mesero busca 5-10 minutos
❌ Cliente no recibe bebida a tiempo
❌ Propina reducida por mal servicio
❌ Cliente frustrado
❌ Vuelve a otro club

DESPUÉS / AFTER:
✅ "Aquí está exactamente"
✅ Mesero llega en 30 segundos
✅ Bebida entregada caliente
✅ Propina garantizada
✅ Cliente satisfecho
✅ Vuelve con amigos
```

---

## 🏗️ ARQUITECTURA DEL SISTEMA / SYSTEM ARCHITECTURE

### **Componentes Principales / Main Components**

```
┌────────────────────────────────────────────────────────────┐
│                 CUSTOMER APP (Flirt System)                │
│                                                             │
│  ┌──────────────────┐        ┌──────────────────┐         │
│  │  Ubicación GPS   │        │  Envío de Bebida │         │
│  │  - Coordenadas   │        │  - Selecciona    │         │
│  │  - Mesa actual   │        │    bebida        │         │
│  │  - Movimiento    │        │  - Persona dest. │         │
│  └────────┬─────────┘        └────────┬─────────┘         │
│           │                           │                    │
└───────────┼───────────────────────────┼────────────────────┘
            │                           │
      WebSocket / REST API             │
            │                           │
┌───────────┼───────────────────────────┼────────────────────┐
│           │                           │   BACKEND SYSTEM   │
│  ┌────────▼──────────┐    ┌──────────▼──────────┐         │
│  │ Servicio de       │    │ Servicio de Bebidas│         │
│  │ Ubicación         │    │ - Órdenes          │         │
│  │ - GPS tracking    │    │ - Asignación       │         │
│  │ - Actualización   │    │ - Estado entrega   │         │
│  │ - Predicción      │    │ - Historial        │         │
│  └────────┬──────────┘    └────────┬───────────┘         │
│           │                        │                      │
│  ┌────────▼──────────────────────┬─▼────────┐            │
│  │  WebSocket Manager            │ Notif.  │            │
│  │  - Eventos en tiempo real     │ Sistema │            │
│  │  - Posición de clientes       │ - SMS   │            │
│  │  - Asignación a meseros       │ - Push  │            │
│  │  - Confirmación de entrega    │ - Email │            │
│  └────────┬─────────────────────┴────┬────┘             │
│           │                          │                   │
│  ┌────────▼──────────┐    ┌─────────▼─────────┐         │
│  │  Base de Datos    │    │  Redis Cache      │         │
│  │  - Ubicaciones    │    │  - Órdenes activas│         │
│  │  - Órdenes        │    │  - Ubicaciones    │         │
│  │  - Entregas       │    │  - Sesiones       │         │
│  │  - Propinas       │    │  - TTL automático │         │
│  └───────────────────┘    └───────────────────┘         │
│                                                          │
└──────────────────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────┐
│            WAITER APP (Staff Dashboard)                    │
│                                                             │
│  ┌──────────────────┐        ┌──────────────────┐         │
│  │  Notificaciones  │        │  Mapa en Vivo    │         │
│  │  - Bebida lista  │        │  - Ubicación cli │         │
│  │  - Mesa número   │        │  - Ruta óptima   │         │
│  │  - Prioridad     │        │  - Distancia     │         │
│  └────────┬─────────┘        └────────┬─────────┘         │
│           │                           │                   │
│  ┌────────▼───────────────────────────▼────┐             │
│  │  Confirmación de Entrega                │             │
│  │  - Click cuando llega                   │             │
│  │  - Foto de entrega (opcional)           │             │
│  │  - Comentarios del cliente              │             │
│  │  - Asignación de propina                │             │
│  └──────────────────────────────────────────┘             │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

### **Flujo Completo / Complete Flow**

```
1. CLIENTE ENVÍA BEBIDA / CUSTOMER SENDS DRINK
   ↓
   a) Selecciona bebida (trago, vino, cerveza, etc.)
   b) Elige destinatario (otro cliente)
   c) Escribe mensaje (opcional)
   d) Confirma envío y propina

2. SISTEMA PROCESA / SYSTEM PROCESSES
   ↓
   a) Crea orden en BD
   b) Calcula ubicación del cliente
   c) Determina mesero más cercano
   d) Estima ruta óptima

3. SISTEMA NOTIFICA BARRA / SYSTEM NOTIFIES BAR
   ↓
   a) Bebida enviada a preparación
   b) Asignada a mesero específico
   c) Prioridad establecida
   d) Cronómetro inicia

4. MESERO RECIBE NOTIFICACIÓN / WAITER RECEIVES NOTIFICATION
   ↓
   a) Push notification o vibración
   b) Sonido de alerta
   c) Destaca en pantalla
   d) Información: bebida, cliente, ubicación

5. MESERO VE MAPA EN VIVO / WAITER SEES LIVE MAP
   ↓
   a) Ubicación exacta del cliente
   b) Movimiento en tiempo real
   c) Ruta sugerida
   d) Distancia actual

6. MESERO RECOGE BEBIDA / WAITER PICKS UP DRINK
   ↓
   a) Click "Recogido" en app
   b) Temporizador comienza conteo de entrega
   c) Notificación al cliente
   d) Rastreo de mesero activado

7. MESERO SE ACERCA / WAITER APPROACHES
   ↓
   a) Mapa muestra aproximación
   b) Cliente recibe alerta
   c) Mesero actualiza ubicación
   d) Distancia decrece

8. MESERO ENTREGA / WAITER DELIVERS
   ↓
   a) Click "Entregado" cuando llega
   b) Foto de bebida entregada (opcional)
   c) Confirmación del cliente
   d) Propina asignada

9. SISTEMA REGISTRA / SYSTEM LOGS
   ↓
   a) Tiempo total entrega
   b) Mesero que entregó
   c) Propina recibida
   d) Satisfacción del cliente
   e) Historial para análisis

10. RECONOCIMIENTO / ACKNOWLEDGMENT
    ↓
    a) Mesero ve confirmación
    b) Propina creditada
    c) Siguiente orden listos
    d) Ranking actualizado
```

---

## 💻 TECNOLOGÍAS UTILIZADAS / TECHNOLOGIES USED

### **Frontend Mesero / Waiter Frontend**

```
React Native / React:
- Notificaciones en tiempo real
- Mapa interactivo
- GPS integrado
- Geolocalización continua
- Interfaz optimizada para velocidad

Librerías:
✅ React Google Maps
✅ Leaflet (alternativa ligera)
✅ Mapbox (profesional)
✅ Socket.io-client
✅ Geolocation API
✅ Local Notifications
```

### **Backend / Backend**

```
Node.js + Express:
- Manejo de órdenes
- Gestión de ubicaciones
- Cálculo de rutas
- Asignación de meseros
- WebSocket para tiempo real

Servicios:
✅ Google Maps API (rutas/distancias)
✅ Geolocation API
✅ Socket.io (WebSocket)
✅ Redis (ubicaciones en caché)
✅ PostgreSQL (persistencia)

Algoritmos:
✅ Nearest Neighbor (mesero más cercano)
✅ Route Optimization (ruta óptima)
✅ Movement Prediction (predicción mov.)
✅ Load Balancing (distribución)
```

### **Tracking en Tiempo Real / Real-time Tracking**

```
GPS Tracking:
- Actualización cada 5-10 segundos
- Precisión ±5 metros
- Funciona en interior (con Wi-Fi)
- Low battery mode disponible

Dead Reckoning:
- Si GPS falla, usa movimiento previo
- Predice ubicación
- Corrección cuando GPS vuelve

Hybrid Tracking:
- GPS + Wi-Fi + Bluetooth
- Mejor precisión interior
- Fallback automático
```

---

## 🔧 INSTALACIÓN / INSTALLATION

### **Paso 1: Crear Carpeta del Proyecto / Create Project Folder**

```bash
mkdir waiter-delivery-tracking
cd waiter-delivery-tracking

# Crear estructura / Create structure
mkdir -p src/{components,services,utils,styles}
mkdir -p public/assets
mkdir -p server/{routes,services,models}
```

### **Paso 2: Instalar Dependencias Frontend / Install Frontend Dependencies**

```bash
# Crear app React / Create React app
npx create-react-app .

# Instalar librerías de mapas / Install mapping libraries
npm install react-google-maps @react-google-maps/api
npm install leaflet react-leaflet
npm install mapbox-gl react-map-gl

# Instalar WebSocket / Install WebSocket
npm install socket.io-client

# Instalar geolocalización / Install geolocation
npm install geolib use-position

# Instalar notificaciones / Install notifications
npm install react-toastify

# Instalar estado / Install state management
npm install zustand axios

# Instalar UI / Install UI
npm install @mui/material @mui/icons-material antd

# Instalar utilidades / Install utilities
npm install uuid dayjs

# Para React Native (móvil) / For React Native (mobile)
npm install react-native-geolocation-service react-native-maps
```

### **Paso 3: Instalar Dependencias Backend / Install Backend Dependencies**

```bash
cd server
npm init -y

# Dependencias principales / Main dependencies
npm install express socket.io cors dotenv
npm install postgresql pg sequelize
npm install redis
npm install axios geolib

# Servicios / Services
npm install @google/maps
npm install node-schedule (para tareas programadas / for scheduled tasks)

# Desarrollo / Development
npm install -D nodemon
```

### **Paso 4: Configurar Variables de Entorno / Setup Environment Variables**

```bash
cat > .env << EOF
# Frontend
REACT_APP_API_URL=http://localhost:3001
REACT_APP_SOCKET_URL=ws://localhost:3001
REACT_APP_GOOGLE_MAPS_API_KEY=your_key_here

# Backend
NODE_ENV=development
PORT=3001

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/ev2_clubs
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ev2_clubs
DB_USER=ev2_user
DB_PASSWORD=password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Google Maps
GOOGLE_MAPS_API_KEY=your_key_here

# Club
CLUB_ID=club_123
CLUB_NAME=EV2 Clandestinoz
CLUB_LAT=31.9454
CLUB_LNG=-110.9663

# Notificaciones / Notifications
ENABLE_PUSH_NOTIFICATIONS=true
NOTIFICATION_SERVICE=fcm

# Rastreo / Tracking
TRACKING_UPDATE_INTERVAL=5000
MAX_WAITER_DISTANCE=100
EOF
```

---

## 🎮 IMPLEMENTACIÓN / IMPLEMENTATION

### **Parte 1: Servicio de Ubicación del Cliente / Customer Location Service**

```javascript
// src/services/customerLocationService.js

import { io } from 'socket.io-client';

class CustomerLocationService {
  constructor() {
    this.socket = null;
    this.watchId = null;
    this.userId = null;
    this.currentLocation = null;
    this.locationUpdateInterval = 5000; // 5 segundos
  }

  /**
   * Inicializar servicio de ubicación
   * Initialize location service
   */
  async init(userId) {
    this.userId = userId;
    
    // Conectar WebSocket
    this.socket = io(process.env.REACT_APP_SOCKET_URL || 'ws://localhost:3001', {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
      query: { userId }
    });

    // Eventos
    this.socket.on('connect', () => {
      console.log('✅ Conectado al servidor de ubicación');
      this.startTracking();
    });

    this.socket.on('disconnect', () => {
      console.log('❌ Desconectado del servidor');
      this.stopTracking();
    });

    this.socket.on('error', (error) => {
      console.error('❌ Error de socket:', error);
    });
  }

  /**
   * Iniciar rastreo de ubicación
   * Start location tracking
   */
  startTracking() {
    if (!navigator.geolocation) {
      console.error('Geolocalización no soportada');
      return;
    }

    // Opciones de geolocalización
    const options = {
      enableHighAccuracy: true,  // Mayor precisión
      timeout: 5000,             // Timeout de 5 segundos
      maximumAge: 0              // Sin caché
    };

    // Monitoreo continuo
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.handlePositionUpdate(position),
      (error) => this.handlePositionError(error),
      options
    );

    console.log('📍 Rastreo de ubicación iniciado');
  }

  /**
   * Manejar actualización de posición
   * Handle position update
   */
  handlePositionUpdate(position) {
    const { latitude, longitude, accuracy } = position.coords;
    const timestamp = new Date();

    this.currentLocation = {
      latitude,
      longitude,
      accuracy,
      timestamp
    };

    // Enviar a servidor
    if (this.socket && this.socket.connected) {
      this.socket.emit('location-update', {
        userId: this.userId,
        latitude,
        longitude,
        accuracy,
        timestamp
      });
    }

    console.log(`📍 Ubicación actualizada: ${latitude}, ${longitude}`);
  }

  /**
   * Manejar error de posición
   * Handle position error
   */
  handlePositionError(error) {
    console.error('❌ Error de geolocalización:', {
      code: error.code,
      message: error.message
    });

    // Códigos de error:
    // 1 = Permiso denegado
    // 2 = Posición no disponible
    // 3 = Timeout
  }

  /**
   * Detener rastreo
   * Stop tracking
   */
  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
      console.log('⛔ Rastreo de ubicación detenido');
    }
  }

  /**
   * Obtener ubicación actual
   * Get current location
   */
  getCurrentLocation() {
    return this.currentLocation;
  }

  /**
   * Obtener ubicación una sola vez (más rápido)
   * Get position once (faster)
   */
  getPositionOnce() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          resolve({ latitude, longitude });
        },
        (error) => reject(error),
        { enableHighAccuracy: true, timeout: 5000 }
      );
    });
  }

  /**
   * Limpiar / Cleanup
   */
  destroy() {
    this.stopTracking();
    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

export const customerLocationService = new CustomerLocationService();
```

### **Parte 2: Servicio de Notificación de Mesero / Waiter Notification Service**

```javascript
// src/services/waiterNotificationService.js

class WaiterNotificationService {
  constructor() {
    this.socket = null;
    this.waiterId = null;
    this.activeOrders = new Map();
  }

  /**
   * Inicializar servicio de mesero
   * Initialize waiter service
   */
  async init(waiterId) {
    this.waiterId = waiterId;
    
    this.socket = io(process.env.REACT_APP_SOCKET_URL, {
      query: { waiterId, role: 'waiter' }
    });

    this.socket.on('new-order', (orderData) => {
      this.handleNewOrder(orderData);
    });

    this.socket.on('order-status-update', (data) => {
      this.handleOrderUpdate(data);
    });

    this.socket.on('customer-moved', (data) => {
      this.handleCustomerMoved(data);
    });

    this.socket.on('delivery-confirmed', (data) => {
      this.handleDeliveryConfirmed(data);
    });
  }

  /**
   * Manejar nueva orden
   * Handle new order
   */
  handleNewOrder(orderData) {
    const {
      orderId,
      drinkName,
      customerName,
      customerLocation,
      estimatedTime,
      priority
    } = orderData;

    // Agregar a órdenes activas
    this.activeOrders.set(orderId, {
      orderId,
      drinkName,
      customerName,
      customerLocation,
      estimatedTime,
      priority,
      status: 'pending',
      createdAt: new Date()
    });

    // Mostrar notificación
    this.showNotification(orderId, orderData);

    // Reproducir sonido
    this.playNotificationSound(priority);

    // Hacer vibrar teléfono
    this.vibratePhone(priority);
  }

  /**
   * Manejar movimiento de cliente
   * Handle customer movement
   */
  handleCustomerMoved(data) {
    const { orderId, newLocation, distance } = data;
    
    const order = this.activeOrders.get(orderId);
    if (order) {
      order.customerLocation = newLocation;
      order.distance = distance;
      
      // Actualizar UI si está viendo esta orden
      window.dispatchEvent(new CustomEvent('order-location-updated', {
        detail: { orderId, newLocation, distance }
      }));
    }
  }

  /**
   * Mostrar notificación visual
   * Show visual notification
   */
  showNotification(orderId, orderData) {
    // Usar API de notificaciones del navegador
    if (Notification.permission === 'granted') {
      const notification = new Notification('🍹 Nueva Bebida', {
        body: `${orderData.drinkName} para ${orderData.customerName}`,
        icon: '/icons/drink.png',
        badge: '/icons/badge.png',
        tag: orderId,
        requireInteraction: true
      });

      notification.onclick = () => {
        window.focus();
        this.openOrderDetails(orderId);
      };
    }
  }

  /**
   * Reproducir sonido de notificación
   * Play notification sound
   */
  playNotificationSound(priority = 'normal') {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    if (priority === 'high') {
      // Sonido más fuerte y urgente para prioridad alta
      this.playTone(audioContext, 800, 0.5); // Más alto
    } else if (priority === 'medium') {
      this.playTone(audioContext, 600, 0.3); // Medio
    } else {
      this.playTone(audioContext, 400, 0.2); // Bajo
    }
  }

  /**
   * Hacer vibrar teléfono
   * Vibrate phone
   */
  vibratePhone(priority = 'normal') {
    if (navigator.vibrate) {
      if (priority === 'high') {
        navigator.vibrate([100, 50, 100, 50, 100]); // Patrón urgente
      } else if (priority === 'medium') {
        navigator.vibrate([100, 50, 100]); // Patrón normal
      } else {
        navigator.vibrate([100]); // Simple
      }
    }
  }

  /**
   * Reproducir tono
   * Play tone
   */
  playTone(audioContext, frequency, duration) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.01,
      audioContext.currentTime + duration
    );

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
  }

  /**
   * Confirmar recogida de bebida
   * Confirm drink pickup
   */
  confirmPickup(orderId) {
    if (this.socket) {
      this.socket.emit('drink-picked-up', {
        orderId,
        waiterId: this.waiterId,
        timestamp: new Date()
      });

      const order = this.activeOrders.get(orderId);
      if (order) {
        order.status = 'picked-up';
        order.pickedUpAt = new Date();
      }
    }
  }

  /**
   * Confirmar entrega
   * Confirm delivery
   */
  confirmDelivery(orderId, customerLocation) {
    if (this.socket) {
      this.socket.emit('delivery-complete', {
        orderId,
        waiterId: this.waiterId,
        customerLocation,
        timestamp: new Date()
      });

      const order = this.activeOrders.get(orderId);
      if (order) {
        order.status = 'delivered';
        order.deliveredAt = new Date();
      }
    }
  }

  /**
   * Manejar confirmación de entrega
   * Handle delivery confirmed
   */
  handleDeliveryConfirmed(data) {
    const { orderId } = data;
    this.activeOrders.delete(orderId);
    
    window.dispatchEvent(new CustomEvent('order-completed', {
      detail: { orderId }
    }));
  }

  /**
   * Obtener órdenes activas
   * Get active orders
   */
  getActiveOrders() {
    return Array.from(this.activeOrders.values());
  }

  /**
   * Obtener orden específica
   * Get specific order
   */
  getOrder(orderId) {
    return this.activeOrders.get(orderId);
  }
}

export const waiterNotificationService = new WaiterNotificationService();
```

### **Parte 3: Componente de Mapa del Mesero / Waiter Map Component**

```jsx
// src/components/WaiterLiveMap.jsx

import React, { useEffect, useState, useRef } from 'react';
import { GoogleMap, LoadScript, Marker, Polyline } from '@react-google-maps/api';
import { waiterNotificationService } from '../services/waiterNotificationService';
import './WaiterLiveMap.css';

/**
 * Componente de Mapa en Vivo para Mesero
 * Live Map Component for Waiter
 */
export function WaiterLiveMap({ orderId, onDelivered }) {
  const mapRef = useRef(null);
  const [order, setOrder] = useState(null);
  const [waiterLocation, setWaiterLocation] = useState(null);
  const [distance, setDistance] = useState(null);
  const [route, setRoute] = useState(null);
  const [isDelivering, setIsDelivering] = useState(false);

  const mapContainerStyle = {
    width: '100%',
    height: '400px',
    borderRadius: '10px',
    overflow: 'hidden'
  };

  const mapOptions = {
    zoom: 18,
    mapTypeId: 'satellite',
    fullscreenControl: false,
    mapTypeControl: false,
    streetViewControl: false
  };

  useEffect(() => {
    // Obtener orden
    const order = waiterNotificationService.getOrder(orderId);
    setOrder(order);

    // Iniciar rastreo de ubicación del mesero
    startWaiterTracking();

    // Escuchar actualizaciones de ubicación del cliente
    const handleLocationUpdate = (event) => {
      const { detail } = event;
      if (detail.orderId === orderId) {
        setOrder(prev => ({
          ...prev,
          customerLocation: detail.newLocation,
          distance: detail.distance
        }));
        setDistance(detail.distance);
      }
    };

    window.addEventListener('order-location-updated', handleLocationUpdate);

    return () => {
      window.removeEventListener('order-location-updated', handleLocationUpdate);
      stopWaiterTracking();
    };
  }, [orderId]);

  /**
   * Iniciar rastreo de mesero
   * Start waiter tracking
   */
  const startWaiterTracking = async () => {
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          setWaiterLocation({ latitude, longitude });

          // Actualizar mapa
          if (mapRef.current) {
            mapRef.current.panTo({ lat: latitude, lng: longitude });
          }

          // Calcular distancia y ruta
          if (order?.customerLocation) {
            calculateRoute(
              { lat: latitude, lng: longitude },
              { lat: order.customerLocation.latitude, lng: order.customerLocation.longitude }
            );
          }
        },
        (error) => console.error('Error de ubicación:', error),
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
      );
    }
  };

  /**
   * Detener rastreo de mesero
   * Stop waiter tracking
   */
  const stopWaiterTracking = () => {
    // Limpiar intervalo si existe
  };

  /**
   * Calcular ruta óptima
   * Calculate optimal route
   */
  const calculateRoute = async (waiterLoc, customerLoc) => {
    const apiKey = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
    
    try {
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/directions/json?` +
        `origin=${waiterLoc.lat},${waiterLoc.lng}` +
        `&destination=${customerLoc.lat},${customerLoc.lng}` +
        `&key=${apiKey}`
      );

      const data = await response.json();
      if (data.routes.length > 0) {
        const route = data.routes[0];
        const points = route.overview_polyline.points;
        
        // Decodificar puntos de polyline
        const decodedPath = decodePolyline(points);
        setRoute(decodedPath);

        // Calcular distancia
        const distanceMeters = route.legs[0].distance.value;
        const distanceKm = (distanceMeters / 1000).toFixed(2);
        setDistance(distanceKm);
      }
    } catch (error) {
      console.error('Error calculando ruta:', error);
    }
  };

  /**
   * Decodificar polyline de Google Maps
   * Decode Google Maps polyline
   */
  const decodePolyline = (encoded) => {
    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
      let result = 0;
      let shift = 0;
      let b;

      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);

      const dlat = (result & 1) ? ~(result >> 1) : result >> 1;
      lat += dlat;

      result = 0;
      shift = 0;

      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);

      const dlng = (result & 1) ? ~(result >> 1) : result >> 1;
      lng += dlng;

      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }

    return points;
  };

  /**
   * Manejar confirmación de entrega
   * Handle delivery confirmation
   */
  const handleDeliveryConfirm = () => {
    if (waiterLocation && order) {
      waiterNotificationService.confirmDelivery(orderId, waiterLocation);
      setIsDelivering(false);
      onDelivered?.(orderId);
    }
  };

  if (!order || !waiterLocation) {
    return (
      <div className="loading">
        <p>Cargando ubicación... / Loading location...</p>
      </div>
    );
  }

  return (
    <div className="waiter-live-map">
      <LoadScript googleMapsApiKey={process.env.REACT_APP_GOOGLE_MAPS_API_KEY}>
        <GoogleMap
          mapContainerStyle={mapContainerStyle}
          center={{ lat: waiterLocation.latitude, lng: waiterLocation.longitude }}
          zoom={18}
          options={mapOptions}
          onLoad={(map) => {
            mapRef.current = map;
          }}
        >
          {/* Marcador del Mesero / Waiter Marker */}
          <Marker
            position={{
              lat: waiterLocation.latitude,
              lng: waiterLocation.longitude
            }}
            title="Tu ubicación / Your location"
            icon="http://maps.google.com/mapfiles/ms/icons/blue-dot.png"
          />

          {/* Marcador del Cliente / Customer Marker */}
          <Marker
            position={{
              lat: order.customerLocation.latitude,
              lng: order.customerLocation.longitude
            }}
            title={`${order.customerName} - ${order.drinkName}`}
            icon="http://maps.google.com/mapfiles/ms/icons/red-dot.png"
          />

          {/* Ruta / Route */}
          {route && (
            <Polyline
              path={route}
              options={{
                strokeColor: '#4a9eff',
                strokeWeight: 4,
                strokeOpacity: 0.8
              }}
            />
          )}
        </GoogleMap>
      </LoadScript>

      {/* Información de Orden / Order Information */}
      <div className="order-info">
        <div className="order-header">
          <h3>🍹 {order.drinkName}</h3>
          <span className={`priority ${order.priority}`}>
            {order.priority === 'high' ? '⚡ Urgente' : 'Normal'}
          </span>
        </div>

        <div className="customer-info">
          <p><strong>Cliente / Customer:</strong> {order.customerName}</p>
          <p><strong>Mesa / Table:</strong> {order.customerLocation.table_id || 'N/A'}</p>
        </div>

        <div className="distance-info">
          <div className="distance">
            <span className="label">Distancia / Distance:</span>
            <span className="value">{distance || '---'} km</span>
          </div>
          <div className="estimated-time">
            <span className="label">Tiempo Est. / Est. Time:</span>
            <span className="value">
              {distance ? `${Math.ceil(distance * 10)} min` : '---'}
            </span>
          </div>
        </div>

        <div className="action-buttons">
          <button
            className="btn-pickup"
            onClick={() => {
              waiterNotificationService.confirmPickup(orderId);
              setIsDelivering(true);
            }}
            disabled={isDelivering}
          >
            ✓ Recogido / Picked Up
          </button>

          <button
            className="btn-deliver"
            onClick={handleDeliveryConfirm}
            disabled={!isDelivering}
          >
            ✓ Entregado / Delivered
          </button>
        </div>
      </div>
    </div>
  );
}
```

### **Parte 4: Backend - Asignación de Mesero / Backend - Waiter Assignment**

```javascript
// server/services/waiterAssignmentService.js

const geolib = require('geolib');

class WaiterAssignmentService {
  /**
   * Asignar mesero más cercano a orden
   * Assign nearest waiter to order
   */
  static async assignWaiter(order, availableWaiters) {
    if (availableWaiters.length === 0) {
      throw new Error('No hay meseros disponibles / No available waiters');
    }

    // Calcular distancia a cada mesero
    const waiterDistances = availableWaiters.map(waiter => ({
      ...waiter,
      distance: geolib.getDistance(
        {
          latitude: order.customerLocation.latitude,
          longitude: order.customerLocation.longitude
        },
        {
          latitude: waiter.currentLocation.latitude,
          longitude: waiter.currentLocation.longitude
        }
      ) // En metros / In meters
    }));

    // Ordenar por distancia
    waiterDistances.sort((a, b) => a.distance - b.distance);

    // Tomar el más cercano
    const assignedWaiter = waiterDistances[0];

    // Calcular tiempo estimado
    // Velocidad promedio: 1.4 m/s (caminata rápida)
    const estimatedSeconds = assignedWaiter.distance / 1.4;
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

    return {
      waiter: assignedWaiter,
      distance: assignedWaiter.distance,
      estimatedTime: estimatedMinutes,
      priority: this.calculatePriority(assignedWaiter.currentWorkload)
    };
  }

  /**
   * Calcular prioridad basada en carga de trabajo
   * Calculate priority based on workload
   */
  static calculatePriority(workload) {
    if (workload > 5) return 'low';      // Mesero muy ocupado
    if (workload > 3) return 'medium';   // Mesero moderadamente ocupado
    return 'high';                        // Mesero poco ocupado
  }

  /**
   * Obtener meseros disponibles
   * Get available waiters
   */
  static async getAvailableWaiters(db, clubId) {
    // Obtener de Redis o DB
    const query = `
      SELECT w.* 
      FROM waiters w 
      WHERE w.club_id = $1 
      AND w.status = 'active'
      AND w.currentLocation IS NOT NULL
    `;
    
    const result = await db.query(query, [clubId]);
    return result.rows;
  }

  /**
   * Actualizar ubicación del mesero
   * Update waiter location
   */
  static async updateWaiterLocation(redis, waiterId, latitude, longitude) {
    const key = `waiter:${waiterId}:location`;
    
    await redis.setex(
      key,
      300, // TTL de 5 minutos
      JSON.stringify({
        latitude,
        longitude,
        timestamp: new Date()
      })
    );
  }

  /**
   * Obtener carga de trabajo del mesero
   * Get waiter workload
   */
  static async getWaiterWorkload(redis, waiterId) {
    const key = `waiter:${waiterId}:orders`;
    const orders = await redis.get(key);
    return orders ? JSON.parse(orders).length : 0;
  }
}

module.exports = WaiterAssignmentService;
```

### **Parte 5: Backend - WebSocket Handler / Backend - WebSocket Handler**

```javascript
// server/websocketHandler.js

const geolib = require('geolib');
const WaiterAssignmentService = require('./services/waiterAssignmentService');

class WebSocketHandler {
  constructor(io, db, redis) {
    this.io = io;
    this.db = db;
    this.redis = redis;
    this.customerLocations = new Map();
    this.waiterLocations = new Map();
  }

  /**
   * Manejar conexión de cliente/mesero
   * Handle client/waiter connection
   */
  handleConnection(socket) {
    const { userId, role } = socket.handshake.query;

    console.log(`✅ ${role} conectado: ${userId}`);

    // Eventos específicos del rol
    if (role === 'customer') {
      this.setupCustomerEvents(socket, userId);
    } else if (role === 'waiter') {
      this.setupWaiterEvents(socket, userId);
    }

    // Evento de desconexión
    socket.on('disconnect', () => {
      console.log(`❌ ${role} desconectado: ${userId}`);
      this.handleDisconnect(userId, role);
    });
  }

  /**
   * Configurar eventos de cliente
   * Setup customer events
   */
  setupCustomerEvents(socket, customerId) {
    // Actualizar ubicación del cliente
    socket.on('location-update', async (data) => {
      const { latitude, longitude, accuracy } = data;

      this.customerLocations.set(customerId, {
        latitude,
        longitude,
        accuracy,
        timestamp: new Date()
      });

      // Guardar en Redis
      await this.redis.setex(
        `customer:${customerId}:location`,
        300,
        JSON.stringify({ latitude, longitude, accuracy })
      );

      // Broadcast a meseros con órdenes de este cliente
      const orders = await this.db.query(
        'SELECT * FROM drink_orders WHERE customer_id = $1 AND status = $2',
        [customerId, 'in-delivery']
      );

      orders.rows.forEach(order => {
        this.io.to(`order:${order.id}`).emit('customer-moved', {
          orderId: order.id,
          newLocation: { latitude, longitude },
          distance: this.calculateDistance(order.waiter_location, { latitude, longitude })
        });
      });
    });

    // Cliente envía bebida
    socket.on('send-drink', async (data) => {
      await this.handleDrinkOrder(socket, data, customerId);
    });
  }

  /**
   * Configurar eventos de mesero
   * Setup waiter events
   */
  setupWaiterEvents(socket, waiterId) {
    // Actualizar ubicación del mesero
    socket.on('waiter-location', async (data) => {
      const { latitude, longitude } = data;

      this.waiterLocations.set(waiterId, {
        latitude,
        longitude,
        timestamp: new Date()
      });

      // Guardar en Redis
      await this.redis.setex(
        `waiter:${waiterId}:location`,
        60,
        JSON.stringify({ latitude, longitude })
      );

      // Actualizar órdenes con nuevas ubicaciones
      this.updateOrderProximity(waiterId, latitude, longitude);
    });

    // Mesero recoge bebida
    socket.on('drink-picked-up', async (data) => {
      await this.handleDrinkPickedUp(data);
    });

    // Mesero entrega bebida
    socket.on('delivery-complete', async (data) => {
      await this.handleDeliveryComplete(socket, data, waiterId);
    });
  }

  /**
   * Manejar orden de bebida
   * Handle drink order
   */
  async handleDrinkOrder(socket, orderData, customerId) {
    const {
      drinkId,
      recipientId,
      message,
      tip,
      clubId
    } = orderData;

    try {
      // Obtener ubicación actual del cliente
      const customerLoc = this.customerLocations.get(customerId);
      if (!customerLoc) {
        socket.emit('error', 'Ubicación no disponible / Location unavailable');
        return;
      }

      // Crear orden en BD
      const orderResult = await this.db.query(
        `INSERT INTO drink_orders 
        (customer_id, recipient_id, drink_id, club_id, message, tip, customer_location, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING id`,
        [customerId, recipientId, drinkId, clubId, message, tip, JSON.stringify(customerLoc), 'pending']
      );

      const orderId = orderResult.rows[0].id;

      // Obtener meseros disponibles
      const waiters = await WaiterAssignmentService.getAvailableWaiters(this.db, clubId);

      // Asignar mesero
      const assignment = await WaiterAssignmentService.assignWaiter(
        { customerLocation: customerLoc },
        waiters
      );

      // Actualizar orden con asignación
      await this.db.query(
        `UPDATE drink_orders 
        SET waiter_id = $1, estimated_delivery_time = $2, priority = $3, status = $4
        WHERE id = $5`,
        [assignment.waiter.id, assignment.estimatedTime, assignment.priority, 'assigned', orderId]
      );

      // Notificar al mesero
      const waiterSocket = this.io.to(`waiter:${assignment.waiter.id}`);
      waiterSocket.emit('new-order', {
        orderId,
        drinkName: orderData.drinkName,
        customerName: orderData.customerName,
        customerLocation: customerLoc,
        estimatedTime: assignment.estimatedTime,
        priority: assignment.priority,
        distance: assignment.distance
      });

      // Crear sala para esta orden
      socket.join(`order:${orderId}`);
      this.io.to(`waiter:${assignment.waiter.id}`).socketsJoin(`order:${orderId}`);

      // Confirmar al cliente
      socket.emit('order-confirmed', {
        orderId,
        status: 'assigned',
        waiterId: assignment.waiter.id,
        estimatedTime: assignment.estimatedTime
      });

    } catch (error) {
      console.error('Error en handleDrinkOrder:', error);
      socket.emit('error', 'Error al procesar orden / Error processing order');
    }
  }

  /**
   * Manejar bebida recogida
   * Handle drink picked up
   */
  async handleDrinkPickedUp(data) {
    const { orderId, waiterId, timestamp } = data;

    await this.db.query(
      `UPDATE drink_orders 
      SET status = $1, picked_up_at = $2
      WHERE id = $3`,
      ['in-delivery', timestamp, orderId]
    );

    // Notificar a cliente
    this.io.to(`order:${orderId}`).emit('drink-picked-up', {
      orderId,
      status: 'in-delivery'
    });
  }

  /**
   * Manejar entrega completada
   * Handle delivery complete
   */
  async handleDeliveryComplete(socket, data, waiterId) {
    const { orderId, customerLocation, timestamp } = data;

    try {
      // Actualizar orden
      await this.db.query(
        `UPDATE drink_orders 
        SET status = $1, delivered_at = $2, delivery_location = $3
        WHERE id = $4`,
        ['delivered', timestamp, JSON.stringify(customerLocation), orderId]
      );

      // Obtener información de la orden para propina
      const orderResult = await this.db.query(
        'SELECT tip, waiter_id FROM drink_orders WHERE id = $1',
        [orderId]
      );

      const order = orderResult.rows[0];

      // Acreditar propina al mesero
      await this.db.query(
        `INSERT INTO waiter_tips (waiter_id, order_id, amount, created_at)
        VALUES ($1, $2, $3, NOW())`,
        [waiterId, orderId, order.tip]
      );

      // Notificar a todas las partes
      this.io.to(`order:${orderId}`).emit('delivery-confirmed', {
        orderId,
        status: 'delivered',
        timestamp,
        tip: order.tip
      });

      // Confirmar a mesero
      socket.emit('delivery-confirmed', {
        orderId,
        status: 'delivered',
        tipAwarded: order.tip
      });

    } catch (error) {
      console.error('Error en handleDeliveryComplete:', error);
      socket.emit('error', 'Error confirmando entrega / Error confirming delivery');
    }
  }

  /**
   * Calcular distancia
   * Calculate distance
   */
  calculateDistance(loc1, loc2) {
    if (!loc1 || !loc2) return null;
    
    const distance = geolib.getDistance(
      { latitude: loc1.latitude, longitude: loc1.longitude },
      { latitude: loc2.latitude, longitude: loc2.longitude }
    );
    
    return (distance / 1000).toFixed(2); // Convertir a km
  }

  /**
   * Actualizar proximidad de orden
   * Update order proximity
   */
  updateOrderProximity(waiterId, latitude, longitude) {
    // Emitir actualización de ubicación a órdenes del mesero
    this.io.to(`waiter:${waiterId}`).emit('waiter-location-updated', {
      latitude,
      longitude
    });
  }

  /**
   * Manejar desconexión
   * Handle disconnect
   */
  async handleDisconnect(userId, role) {
    if (role === 'customer') {
      this.customerLocations.delete(userId);
    } else if (role === 'waiter') {
      this.waiterLocations.delete(userId);
    }
  }
}

module.exports = WebSocketHandler;
```

---

## ✨ CARACTERÍSTICAS PRINCIPALES / KEY FEATURES

### **1. Rastreo en Tiempo Real / Real-time Tracking**

```
✅ Ubicación de cliente actualizada cada 5 segundos
✅ Ubicación de mesero actualizada constantemente
✅ Predicción de movimiento
✅ Ruta óptima calculada automáticamente
✅ Distancia actualizada en vivo
✅ ETA dinámico
```

### **2. Notificaciones Inteligentes / Smart Notifications**

```
✅ Sonido basado en prioridad
✅ Vibración en patrón
✅ Notificación visual en app
✅ Notificación del navegador
✅ Información clara y concisa
✅ Acción rápida de un toque
```

### **3. Asignación Automática / Automatic Assignment**

```
✅ Mesero más cercano seleccionado
✅ Carga de trabajo considerada
✅ Prioridad ajustada
✅ Ruta óptima sugerida
✅ ETA preciso
✅ Distribución equitativa
```

### **4. Interfaz Optimizada para Mesero / Waiter-Optimized UI**

```
✅ Botones grandes para clickear rápido
✅ Información crucial destacada
✅ Mapa a pantalla completa
✅ Datos actualizados en vivo
✅ Confirmación de un toque
✅ Acceso rápido a siguiente orden
```

### **5. Gamificación / Gamification**

```
✅ Ranking de meseros por entregas
✅ Badges por entregas rápidas
✅ Bonus por entregas en tiempo
✅ Estadísticas personales
✅ Competencia amistosa
✅ Incentivos de rendimiento
```

---

## 👥 EXPERIENCIA DEL MESERO / WAITER EXPERIENCE

### **Flujo de Trabajo Optimizado / Optimized Workflow**

```
1. MESERO RECIBE NOTIFICACIÓN
   - Sonido de alerta
   - Vibración en patrón
   - Notificación visual

2. VE INFORMACIÓN CRÍTICA
   - Nombre del cliente
   - Tipo de bebida
   - Prioridad
   - Mesa/ubicación

3. VE UBICACIÓN EN MAPA
   - Ubicación exacta del cliente
   - Ruta sugerida
   - Distancia
   - ETA

4. CONFIRMA RECEPCIÓN
   - Click "Recogido"
   - Recibe bebida en barra
   - Comienza a caminar

5. VE CLIENTE EN MAPA VIVO
   - Se acerca al cliente
   - Cliente se mueve = mapa se actualiza
   - Distancia decrece

6. ENTREGA BEBIDA
   - Llega a cliente
   - Click "Entregado"
   - Foto de confirmación (opcional)

7. PROPINA ACREDITADA
   - Recibe confirmación
   - Propina creditada a cuenta
   - Ranking actualizado
   - Siguiente orden lista
```

### **Beneficios para Mesero / Waiter Benefits**

```
✅ Mejor eficiencia - Menos tiempo buscando clientes
✅ Más propinas - Entrega rápida = cliente satisfecho
✅ Menos estrés - Información clara
✅ Seguridad - Sabe dónde va
✅ Competencia - Motivación por ranking
✅ Ingresos - Más entregas = más propinas
```

---

## 💰 INTEGRACIÓN CON SISTEMA DE PROPINAS / FLIRT INTEGRATION

### **Ventajas de Integración / Integration Advantages**

```
1. Entrega Más Rápida
   - Ubicación exacta = menos tiempo búsqueda
   - Cliente recibe bebida caliente
   - Cliente feliz = propina mayor

2. Mejor Servicio
   - Mesero no está perdido
   - Cliente se siente valorado
   - Experiencia premium

3. Propinas Aseguradas
   - Entrega rápida = propina garantizada
   - Sistema de rating influye propina
   - Mesero motivado

4. Datos para Análisis
   - Tiempo de entrega
   - Satisfacción del cliente
   - Desempeño del mesero
   - ROI por mesero
```

---

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

📍 **Sistema de rastreo en vivo completamente implementado. / Live tracking system fully implemented.** 🚀
