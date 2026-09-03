# 💳 SISTEMA DE FACTURACIÓN EN VIVO Y ALERTAS DE ÓRDENES
# 💳 LIVE BILLING SYSTEM & ORDER NOTIFICATION ALERTS

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

---

## 📋 TABLA DE CONTENIDOS / TABLE OF CONTENTS

1. [Descripción General / Overview](#descripción-general)
2. [Arquitectura del Sistema / System Architecture](#arquitectura-del-sistema)
3. [Acceso a Factura / Bill Access](#acceso-a-factura)
4. [Notificaciones de Órdenes / Order Notifications](#notificaciones-de-órdenes)
5. [Transparencia de Precios / Price Transparency](#transparencia-de-precios)
6. [Historial de Transacciones / Transaction History](#historial-de-transacciones)
7. [Alertas de Anomalías / Anomaly Alerts](#alertas-de-anomalías)
8. [Implementación / Implementation](#implementación)

---

## 🎯 DESCRIPCIÓN GENERAL / OVERVIEW

### **¿QUÉ ES? / WHAT IS IT?**

Sistema de transparencia total que permite al cliente:
- 💳 Ver su factura actualizada EN TIEMPO REAL
- 🔔 Recibir notificación CADA VEZ que ordena algo
- 📊 Ver desglose detallado de gastos
- 🚨 Alertas si hay cargo sospechoso
- ✅ Confirmar o rechazar cada cargo
- 🔐 Seguridad y protección contra fraude
- 📱 Acceso desde teléfono en cualquier momento

Complete transparency system that allows customers to:
- 💳 View their bill updated in REAL-TIME
- 🔔 Receive notification EVERY TIME they order something
- 📊 See detailed breakdown of expenses
- 🚨 Alerts if there's suspicious charge
- ✅ Confirm or reject each charge
- 🔐 Security and fraud protection
- 📱 Access from phone anytime

### **PROBLEMA QUE RESUELVE / PROBLEM IT SOLVES**

```
ANTES / BEFORE:
❌ Cliente no ve la factura hasta final
❌ "¿Cuánto me gasté?"
❌ Sorpresa desagradable al pedir cuenta
❌ Desconfianza en mesero/club
❌ Discusiones sobre precios
❌ Experiencia negativa
❌ No vuelve al club

DESPUÉS / AFTER:
✅ Cliente ve factura actualizada
✅ "Veo exactamente qué gasté"
✅ Notificación cada orden
✅ Confianza total en club
✅ Sin sorpresas
✅ Experiencia transparente
✅ Vuelve con confianza
```

---

## 🏗️ ARQUITECTURA DEL SISTEMA / SYSTEM ARCHITECTURE

### **Componentes Principales / Main Components**

```
┌─────────────────────────────────────────────────┐
│         CLIENTE APP (Customer App)              │
│                                                  │
│  ┌──────────────────┐    ┌──────────────────┐  │
│  │  Acceso Factura  │    │  Notificaciones  │  │
│  │  - Ver en vivo   │    │  - Push alerts   │  │
│  │  - Desglose      │    │  - Email alerts  │  │
│  │  - Historial     │    │  - SMS alerts    │  │
│  └────────┬─────────┘    └────────┬─────────┘  │
│           │                       │             │
└───────────┼───────────────────────┼─────────────┘
            │                       │
      REST API / WebSocket         │
            │                       │
┌───────────┼───────────────────────┼─────────────┐
│           │                       │  BACKEND    │
│  ┌────────▼──────────┐ ┌─────────▼────────┐   │
│  │ Servicio Factura  │ │ Servicio Órdenes │   │
│  │ - Cálculo total   │ │ - Registra orden  │   │
│  │ - Desglose items  │ │ - Verifica precio │   │
│  │ - Impuestos       │ │ - Detecta fraude  │   │
│  │ - Propinas        │ │ - Envía alertas   │   │
│  │ - Descuentos      │ │ - Confirmación    │   │
│  └────────┬──────────┘ └────────┬─────────┘   │
│           │                     │              │
│  ┌────────▼─────────────────────▼────┐        │
│  │  Servicio de Notificaciones       │        │
│  │  - Push notifications             │        │
│  │  - Email                          │        │
│  │  - SMS                            │        │
│  │  - In-app alerts                  │        │
│  │  - Logging                        │        │
│  └────────┬────────────────────────┬─┘        │
│           │                        │           │
│  ┌────────▼─────────┐  ┌──────────▼───────┐  │
│  │  Base de Datos   │  │  Redis Cache     │  │
│  │  - Facturas      │  │  - Factura activa│  │
│  │  - Órdenes       │  │  - Total actual  │  │
│  │  - Items         │  │  - Notificaciones│  │
│  │  - Transacciones │  │  - Sesiones      │  │
│  │  - Alertas       │  │  - TTL auto      │  │
│  └──────────────────┘  └──────────────────┘  │
│                                                │
└────────────────────────────────────────────────┘
```

### **Flujo de Datos / Data Flow**

```
1. CLIENTE ORDENA BEBIDA / CUSTOMER ORDERS DRINK
   ↓
2. SISTEMA CREA ORDEN / SYSTEM CREATES ORDER
   ↓
3. CALCULA PRECIO / CALCULATE PRICE
   - Item base / Base item
   - Impuestos / Taxes
   - Propina sugerida / Suggested tip
   ↓
4. ACTUALIZA FACTURA EN CACHÉ / UPDATE INVOICE IN CACHE
   ↓
5. ENVÍA NOTIFICACIÓN AL CLIENTE / SEND NOTIFICATION TO CUSTOMER
   - Push notification
   - Email (opcional)
   - SMS (opcional)
   - Alerta en app
   ↓
6. CLIENTE VE EN APP
   - Factura actualizada
   - Nueva orden añadida
   - Total nuevo
   ↓
7. CLIENTE PUEDE
   - Ver desglose
   - Confirmar orden
   - Rechazar cargo
   - Ver historial
   - Reportar anomalía
   ↓
8. MESERO VE EN SISTEMA
   - Orden confirmada
   - Puede ser rechazada
   - Preparar bebida
   ↓
9. CLIENTE PAGA
   - Ve factura final
   - Confirma pago
   - Recibe comprobante
```

---

## 💳 ACCESO A FACTURA / BILL ACCESS

### **Qué Ve el Cliente / What Customer Sees**

```
┌─────────────────────────────────────────┐
│  💳 TU FACTURA ACTUAL / YOUR BILL       │
├─────────────────────────────────────────┤
│                                         │
│  Mesa / Table: 15                       │
│  Hora Inicio / Start Time: 22:30        │
│  Tiempo en Club / Time in Club: 1h 20m  │
│                                         │
├─────────────────────────────────────────┤
│  📝 DESGLOSE / BREAKDOWN                │
│                                         │
│  Margarita                   $120       │
│  - Bebida                              │
│  - Hielo Premium                       │
│                                         │
│  Cerveza Corona              $80        │
│  - Bebida                              │
│                                         │
│  Propina Enviada             $250       │
│  - A Bailarina (María)                 │
│                                         │
├─────────────────────────────────────────┤
│  Subtotal:                   $450       │
│  Impuestos (16%):            $72        │
│  Propinas Enviadas:          $250       │
│                                         │
│  TOTAL:                    $772 MXN    │
│  Equivalente:              $44 USD     │
│                                         │
├─────────────────────────────────────────┤
│  [📋 Ver Historial] [✓ Confirmar]     │
│  [❌ Reportar] [💬 Chat Soporte]      │
└─────────────────────────────────────────┘
```

### **Desglose Detallado / Detailed Breakdown**

```jsx
// Componente Factura Detallada
<InvoiceBreakdown>
  
  // Órdenes / Orders
  <OrdersSection>
    <OrderItem
      id="order-001"
      time="22:35"
      item="Margarita"
      price={120}
      status="delivered"
      confirmed={true}
      notes="Bebida alcohólica"
    />
    <OrderItem
      id="order-002"
      time="22:45"
      item="Cerveza Corona"
      price={80}
      status="delivered"
      confirmed={true}
      notes="Bebida"
    />
  </OrdersSection>

  // Propinas Enviadas / Tips Sent
  <TipsSection>
    <TipItem
      id="tip-001"
      time="22:40"
      recipient="María García"
      amount={150}
      staffRole="Bailarina"
      message="Excelente presentación"
      confirmed={true}
    />
    <TipItem
      id="tip-002"
      time="23:00"
      recipient="Juan Pérez"
      amount={100}
      staffRole="Bartender"
      message="Bebida perfecta"
      confirmed={true}
    />
  </TipsSection>

  // Resumen / Summary
  <SummarySection>
    <SummaryRow label="Subtotal" value={450} />
    <SummaryRow label="Impuestos (16%)" value={72} />
    <SummaryRow label="Total Órdenes" value={522} />
    <SummaryRow label="Total Propinas" value={250} />
    <SummaryRow 
      label="TOTAL GENERAL" 
      value={772} 
      highlight={true}
    />
    <CurrencySwitch from="MXN" to="USD" rate={17.5} />
  </SummarySection>

  // Acciones / Actions
  <ActionsSection>
    <ConfirmButton />
    <ReportButton />
    <SupportChatButton />
    <PrintButton />
    <ShareButton />
  </ActionsSection>
</InvoiceBreakdown>
```

---

## 🔔 NOTIFICACIONES DE ÓRDENES / ORDER NOTIFICATIONS

### **Tipos de Notificaciones / Notification Types**

```
1. ORDEN CONFIRMADA / ORDER CONFIRMED
   ┌────────────────────────────┐
   │ 🔔 Nueva Orden Confirmada  │
   ├────────────────────────────┤
   │ Margarita                  │
   │ Precio: $120 MXN          │
   │ Total Actualizado: $522   │
   │ [Ver Factura] [Aceptar]   │
   └────────────────────────────┘

2. ORDEN ENTREGADA / ORDER DELIVERED
   ┌────────────────────────────┐
   │ ✅ Bebida Entregada        │
   ├────────────────────────────┤
   │ Margarita                  │
   │ Entregada por: Juan        │
   │ Tiempo: 4 minutos          │
   │ Propina Sugerida: $15      │
   │ [Enviar Propina] [Aceptar] │
   └────────────────────────────┘

3. PROPINA ENVIADA / TIP SENT
   ┌────────────────────────────┐
   │ 💝 Propina Enviada         │
   ├────────────────────────────┤
   │ $150 MXN a María García    │
   │ (Bailarina)                │
   │ Mensaje: "Excelente!"      │
   │ Total Actualizado: $622    │
   │ [Ver Factura]              │
   └────────────────────────────┘

4. ALERTA DE ANOMALÍA / ANOMALY ALERT
   ┌────────────────────────────┐
   │ ⚠️ Alerta de Cargo         │
   ├────────────────────────────┤
   │ Cargo inesperado detectado │
   │ Item: "Propina automática" │
   │ Monto: $150 MXN            │
   │ ¿Reconoces este cargo?     │
   │ [Sí, es correcto] [No, ❌] │
   └────────────────────────────┘

5. NOTIFICACIÓN DE DESCUENTO / DISCOUNT ALERT
   ┌────────────────────────────┐
   │ 🎉 Descuento Aplicado      │
   ├────────────────────────────┤
   │ Happy Hour: -20%           │
   │ Ahorro: $24 MXN            │
   │ Total: $498 MXN            │
   │ ¡Aprovechar! [Ver]         │
   └────────────────────────────┘
```

### **Canales de Notificación / Notification Channels**

```
1. PUSH NOTIFICATION (App)
   - Instantáneo / Instant
   - En pantalla / On screen
   - Sonido + Vibración / Sound + Vibration
   - Prioridad alta / High priority

2. EMAIL
   - Resumen de orden / Order summary
   - Comprobante / Receipt
   - Seguimiento / Follow-up
   - Opcional / Optional

3. SMS
   - Mensaje de texto / Text message
   - Confirmación / Confirmation
   - Alerta crítica / Critical alert
   - Opcional / Optional

4. IN-APP ALERT
   - Banner en app / Banner in app
   - Sound / Sonido
   - Red dot icon / Icono punto rojo
   - Permanece hasta confirmar / Stays until confirmed
```

---

## 📊 TRANSPARENCIA DE PRECIOS / PRICE TRANSPARENCY

### **Componente de Transparencia / Transparency Component**

```jsx
// src/components/PriceTransparency.jsx

import React, { useEffect, useState } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import './PriceTransparency.css';

/**
 * Componente de Transparencia de Precios
 * Price Transparency Component
 */
export function PriceTransparency({ customerId, clubId }) {
  const [bill, setBill] = useState(null);
  const [orders, setOrders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [expandedOrder, setExpandedOrder] = useState(null);
  const { socket } = useWebSocket();

  useEffect(() => {
    // Conectar a WebSocket para actualizaciones en vivo
    if (socket) {
      socket.on('bill-updated', handleBillUpdate);
      socket.on('order-confirmed', handleOrderConfirmed);
      socket.on('price-alert', handlePriceAlert);

      // Pedir factura actual / Request current bill
      socket.emit('get-bill', { customerId, clubId });
    }

    return () => {
      if (socket) {
        socket.off('bill-updated');
        socket.off('order-confirmed');
        socket.off('price-alert');
      }
    };
  }, [socket, customerId, clubId]);

  /**
   * Manejar actualización de factura
   * Handle bill update
   */
  const handleBillUpdate = (data) => {
    const {
      orderId,
      orderData,
      newTotal,
      breakdown,
      timestamp
    } = data;

    // Actualizar factura
    setBill({
      ...bill,
      items: [...(bill?.items || []), orderData],
      total: newTotal,
      breakdown,
      lastUpdated: timestamp
    });

    // Guardar orden
    setOrders([...orders, {
      id: orderId,
      ...orderData,
      confirmed: false,
      timestamp
    }]);

    // Mostrar notificación
    showNotification({
      type: 'order-confirmed',
      title: 'Nueva Orden',
      message: `${orderData.name} - $${orderData.price}`,
      orderData
    });
  };

  /**
   * Manejar confirmación de orden
   * Handle order confirmation
   */
  const handleOrderConfirmed = (data) => {
    const { orderId } = data;
    
    // Actualizar estado de orden
    setOrders(orders.map(o =>
      o.id === orderId ? { ...o, confirmed: true } : o
    ));
  };

  /**
   * Manejar alerta de precio
   * Handle price alert
   */
  const handlePriceAlert = (data) => {
    const { orderId, issue, suggestedPrice, actualPrice } = data;

    // Mostrar alerta
    showNotification({
      type: 'price-alert',
      title: '⚠️ Alerta de Precio',
      message: issue,
      severity: 'warning',
      actions: [
        { label: 'Aceptar', action: () => confirmPrice(orderId) },
        { label: 'Rechazar', action: () => rejectPrice(orderId) }
      ],
      details: {
        suggested: suggestedPrice,
        actual: actualPrice
      }
    });
  };

  /**
   * Mostrar notificación
   * Show notification
   */
  const showNotification = (notification) => {
    const id = Math.random().toString(36);
    const notif = { ...notification, id };

    setNotifications([...notifications, notif]);

    // Auto-remover después de 5 segundos (si no es crítica)
    if (notification.type !== 'price-alert') {
      setTimeout(() => {
        setNotifications(n => n.filter(x => x.id !== id));
      }, 5000);
    }
  };

  /**
   * Confirmar precio
   * Confirm price
   */
  const confirmPrice = (orderId) => {
    socket.emit('confirm-order-price', { orderId, customerId });
    
    // Remover notificación
    setNotifications(n => n.filter(x => x.id !== orderId));
  };

  /**
   * Rechazar precio
   * Reject price
   */
  const rejectPrice = (orderId) => {
    socket.emit('reject-order-price', {
      orderId,
      customerId,
      reason: 'Precio incorrecto'
    });

    // Mostrar alerta de contacto con soporte
    showNotification({
      type: 'support-contact',
      title: 'Contactando Soporte',
      message: 'Un mesero se comunicará contigo pronto',
      severity: 'info'
    });
  };

  if (!bill) {
    return <div className="loading">Cargando factura...</div>;
  }

  return (
    <div className="price-transparency">
      {/* Notificaciones flotantes / Floating Notifications */}
      <div className="notifications-container">
        {notifications.map(notif => (
          <NotificationCard
            key={notif.id}
            notification={notif}
            onAction={notif.actions?.[0]?.action}
          />
        ))}
      </div>

      {/* Encabezado / Header */}
      <div className="bill-header">
        <h2>💳 Tu Factura Actual</h2>
        <span className="last-updated">
          Actualizado: {new Date(bill.lastUpdated).toLocaleTimeString()}
        </span>
      </div>

      {/* Información de Mesa / Table Info */}
      <div className="table-info">
        <div className="info-item">
          <span className="label">Mesa / Table:</span>
          <span className="value">{bill.tableNumber}</span>
        </div>
        <div className="info-item">
          <span className="label">Hora Inicio / Start:</span>
          <span className="value">{new Date(bill.startTime).toLocaleTimeString()}</span>
        </div>
        <div className="info-item">
          <span className="label">Tiempo / Duration:</span>
          <span className="value">{calculateDuration(bill.startTime)}</span>
        </div>
      </div>

      {/* Órdenes / Orders */}
      <div className="orders-section">
        <h3>📝 Órdenes ({orders.length})</h3>
        <div className="orders-list">
          {orders.map((order, idx) => (
            <OrderRow
              key={order.id}
              order={order}
              index={idx}
              expanded={expandedOrder === order.id}
              onExpand={() => setExpandedOrder(
                expandedOrder === order.id ? null : order.id
              )}
              onConfirm={() => confirmPrice(order.id)}
              onReject={() => rejectPrice(order.id)}
            />
          ))}
        </div>
      </div>

      {/* Resumen / Summary */}
      <div className="bill-summary">
        <div className="summary-row">
          <span className="label">Subtotal:</span>
          <span className="value">${bill.breakdown.subtotal}</span>
        </div>
        <div className="summary-row">
          <span className="label">Impuestos ({bill.breakdown.taxRate}%):</span>
          <span className="value">${bill.breakdown.taxes}</span>
        </div>
        <div className="summary-row">
          <span className="label">Propinas Enviadas:</span>
          <span className="value">${bill.breakdown.tips}</span>
        </div>
        <div className="summary-row highlight">
          <span className="label">TOTAL:</span>
          <span className="value">${bill.total} MXN</span>
        </div>
        <div className="currency-conversion">
          ≈ ${(bill.total / 17.5).toFixed(2)} USD
        </div>
      </div>

      {/* Acciones / Actions */}
      <div className="bill-actions">
        <button className="btn-print" onClick={() => printBill()}>
          🖨️ Imprimir / Print
        </button>
        <button className="btn-share" onClick={() => shareBill()}>
          📤 Compartir / Share
        </button>
        <button className="btn-support" onClick={() => contactSupport()}>
          💬 Contactar Soporte
        </button>
        <button className="btn-pay" onClick={() => goToPay()}>
          ✅ Pagar / Pay
        </button>
      </div>

      {/* Historial / History */}
      <div className="bill-history">
        <h3>📋 Historial Completo / Full History</h3>
        <TransactionHistory transactions={bill.allTransactions} />
      </div>
    </div>
  );
}

/**
 * Componente Row de Orden
 * Order Row Component
 */
function OrderRow({ order, index, expanded, onExpand, onConfirm, onReject }) {
  return (
    <div className={`order-row ${expanded ? 'expanded' : ''}`}>
      <div className="order-header" onClick={onExpand}>
        <span className="order-number">#{index + 1}</span>
        <span className="order-time">
          {new Date(order.timestamp).toLocaleTimeString()}
        </span>
        <span className="order-item">{order.name}</span>
        <span className="order-price">${order.price}</span>
        <span className={`order-status ${order.confirmed ? 'confirmed' : 'pending'}`}>
          {order.confirmed ? '✓ Confirmada' : '⏳ Pendiente'}
        </span>
      </div>

      {expanded && (
        <div className="order-details">
          <div className="detail-item">
            <span>Descripción:</span>
            <span>{order.description}</span>
          </div>
          <div className="detail-item">
            <span>Categoría:</span>
            <span>{order.category}</span>
          </div>
          <div className="detail-item">
            <span>Estado:</span>
            <span>{order.status}</span>
          </div>
          {!order.confirmed && (
            <div className="detail-actions">
              <button className="btn-confirm" onClick={onConfirm}>
                ✓ Confirmar
              </button>
              <button className="btn-reject" onClick={onReject}>
                ✗ Rechazar
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Componente Tarjeta de Notificación
 * Notification Card Component
 */
function NotificationCard({ notification, onAction }) {
  const getSeverityClass = (severity) => {
    switch (severity) {
      case 'warning': return 'severity-warning';
      case 'error': return 'severity-error';
      case 'success': return 'severity-success';
      case 'info': return 'severity-info';
      default: return '';
    }
  };

  return (
    <div className={`notification-card ${getSeverityClass(notification.severity)}`}>
      <div className="notification-header">
        <span className="notification-title">{notification.title}</span>
        <button className="close-btn">×</button>
      </div>
      <div className="notification-message">
        {notification.message}
      </div>
      {notification.details && (
        <div className="notification-details">
          {Object.entries(notification.details).map(([key, value]) => (
            <div key={key} className="detail">
              <span className="key">{key}:</span>
              <span className="value">${value}</span>
            </div>
          ))}
        </div>
      )}
      {notification.actions && (
        <div className="notification-actions">
          {notification.actions.map((action, idx) => (
            <button
              key={idx}
              className="action-btn"
              onClick={action.action}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Componente Historial de Transacciones
 * Transaction History Component
 */
function TransactionHistory({ transactions }) {
  return (
    <table className="history-table">
      <thead>
        <tr>
          <th>Hora / Time</th>
          <th>Descripción / Description</th>
          <th>Monto / Amount</th>
          <th>Estado / Status</th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((tx, idx) => (
          <tr key={idx} className={`status-${tx.status}`}>
            <td>{new Date(tx.timestamp).toLocaleTimeString()}</td>
            <td>{tx.description}</td>
            <td>${tx.amount}</td>
            <td>
              <span className={`badge badge-${tx.status}`}>
                {tx.status}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Funciones Auxiliares / Helper Functions
 */
function calculateDuration(startTime) {
  const now = new Date();
  const start = new Date(startTime);
  const diff = now - start;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

function printBill() {
  window.print();
}

function shareBill() {
  // Implementar compartir factura
  const billData = window.location.href;
  if (navigator.share) {
    navigator.share({
      title: 'Mi Factura',
      text: 'Factura del Club',
      url: billData
    });
  }
}

function contactSupport() {
  // Abrir chat de soporte
  window.location.href = '#support-chat';
}

function goToPay() {
  // Ir a página de pago
  window.location.href = '#payment';
}
```

---

## 🚨 ALERTAS DE ANOMALÍAS / ANOMALY ALERTS

### **Detección Automática de Fraude / Automatic Fraud Detection**

```javascript
// server/services/fraudDetectionService.js

class FraudDetectionService {
  /**
   * Analizar orden para anomalías
   * Analyze order for anomalies
   */
  static async analyzeOrder(order, customerHistory, clubNorms) {
    const anomalies = [];

    // 1. Precio fuera de rango / Price out of range
    const priceAnomaly = this.checkPriceAnomaly(
      order.price,
      order.itemType,
      clubNorms
    );
    if (priceAnomaly) {
      anomalies.push({
        type: 'price-anomaly',
        severity: 'high',
        description: `Precio ${priceAnomaly.difference}% por encima del normal`,
        suggestedPrice: priceAnomaly.normalPrice,
        actualPrice: order.price
      });
    }

    // 2. Patrón de gasto anormal / Unusual spending pattern
    const spendingAnomaly = this.checkSpendingPattern(
      order.price,
      customerHistory
    );
    if (spendingAnomaly) {
      anomalies.push({
        type: 'spending-anomaly',
        severity: 'medium',
        description: `Gasto ${spendingAnomaly.percentile}% por encima de tu promedio`,
        averageSpend: spendingAnomaly.average,
        currentSpend: order.price
      });
    }

    // 3. Múltiples órdenes en corto tiempo / Multiple orders in short time
    const rapidOrderAnomaly = this.checkRapidOrders(
      customerHistory
    );
    if (rapidOrderAnomaly) {
      anomalies.push({
        type: 'rapid-orders',
        severity: 'high',
        description: `${rapidOrderAnomaly.count} órdenes en ${rapidOrderAnomaly.minutes} minutos`,
        count: rapidOrderAnomaly.count,
        timeWindow: rapidOrderAnomaly.minutes
      });
    }

    // 4. Propina sospechosa / Suspicious tip
    if (order.type === 'tip') {
      const tipAnomaly = this.checkSuspiciousTip(
        order.amount,
        customerHistory
      );
      if (tipAnomaly) {
        anomalies.push({
          type: 'suspicious-tip',
          severity: 'medium',
          description: `Propina ${tipAnomaly.percentile}% por encima de tu promedio`,
          averageTip: tipAnomaly.average,
          currentTip: order.amount
        });
      }
    }

    // 5. Duplicado potencial / Potential duplicate
    const duplicateAnomaly = this.checkDuplicate(
      order,
      customerHistory
    );
    if (duplicateAnomaly) {
      anomalies.push({
        type: 'duplicate-order',
        severity: 'high',
        description: 'Orden similar encontrada hace poco tiempo',
        duplicateId: duplicateAnomaly.orderId,
        timeDifference: duplicateAnomaly.minutes
      });
    }

    return anomalies;
  }

  /**
   * Verificar anomalía de precio
   * Check price anomaly
   */
  static checkPriceAnomaly(price, itemType, clubNorms) {
    const normalPrice = clubNorms[itemType]?.average || price;
    const maxPrice = clubNorms[itemType]?.max || normalPrice * 1.5;

    if (price > maxPrice) {
      return {
        normalPrice,
        maxPrice,
        difference: Math.round(((price - normalPrice) / normalPrice) * 100)
      };
    }
    return null;
  }

  /**
   * Verificar patrón de gasto
   * Check spending pattern
   */
  static checkSpendingPattern(currentSpend, customerHistory) {
    const spends = customerHistory.map(h => h.amount);
    const average = spends.reduce((a, b) => a + b, 0) / spends.length;
    const stdDev = this.calculateStdDev(spends, average);

    // Alertar si más de 2 desviaciones estándar
    if (currentSpend > average + (2 * stdDev)) {
      const percentile = Math.round(((currentSpend - average) / average) * 100);
      return { average, percentile };
    }
    return null;
  }

  /**
   * Verificar órdenes rápidas
   * Check rapid orders
   */
  static checkRapidOrders(customerHistory) {
    const last5Minutes = customerHistory.filter(h => {
      const timeDiff = (new Date() - new Date(h.timestamp)) / 1000 / 60;
      return timeDiff <= 5;
    });

    if (last5Minutes.length >= 3) {
      return {
        count: last5Minutes.length,
        minutes: 5
      };
    }
    return null;
  }

  /**
   * Verificar propina sospechosa
   * Check suspicious tip
   */
  static checkSuspiciousTip(amount, customerHistory) {
    const tips = customerHistory
      .filter(h => h.type === 'tip')
      .map(h => h.amount);

    if (tips.length === 0) return null;

    const average = tips.reduce((a, b) => a + b, 0) / tips.length;
    const maxNormal = average * 2;

    if (amount > maxNormal) {
      const percentile = Math.round(((amount - average) / average) * 100);
      return { average, percentile };
    }
    return null;
  }

  /**
   * Verificar duplicado
   * Check duplicate
   */
  static checkDuplicate(order, customerHistory) {
    const duplicates = customerHistory.filter(h => {
      const timeDiff = (new Date() - new Date(h.timestamp)) / 1000 / 60;
      return (
        h.itemName === order.itemName &&
        h.amount === order.amount &&
        timeDiff <= 10 // Dentro de 10 minutos
      );
    });

    if (duplicates.length > 0) {
      return {
        orderId: duplicates[0].id,
        minutes: Math.round(
          (new Date() - new Date(duplicates[0].timestamp)) / 1000 / 60
        )
      };
    }
    return null;
  }

  /**
   * Calcular desviación estándar
   * Calculate standard deviation
   */
  static calculateStdDev(values, average) {
    const squaredDiffs = values.map(v => Math.pow(v - average, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b) / values.length;
    return Math.sqrt(avgSquaredDiff);
  }
}

module.exports = FraudDetectionService;
```

---

## 📱 HISTORIAL DE TRANSACCIONES / TRANSACTION HISTORY

### **Vista de Historial / History View**

```jsx
// src/components/TransactionHistory.jsx

export function TransactionHistory({ customerId }) {
  const [transactions, setTransactions] = useState([]);
  const [filter, setFilter] = useState('all'); // all, orders, tips, alerts
  const [sortBy, setSortBy] = useState('date'); // date, amount, type

  const filteredTransactions = transactions
    .filter(t => filter === 'all' || t.type === filter)
    .sort((a, b) => {
      if (sortBy === 'date') return new Date(b.timestamp) - new Date(a.timestamp);
      if (sortBy === 'amount') return b.amount - a.amount;
      return 0;
    });

  return (
    <div className="transaction-history">
      <h3>📊 Historial Completo</h3>

      {/* Filtros */}
      <div className="filters">
        <button
          className={filter === 'all' ? 'active' : ''}
          onClick={() => setFilter('all')}
        >
          Todas ({transactions.length})
        </button>
        <button
          className={filter === 'order' ? 'active' : ''}
          onClick={() => setFilter('order')}
        >
          Órdenes
        </button>
        <button
          className={filter === 'tip' ? 'active' : ''}
          onClick={() => setFilter('tip')}
        >
          Propinas
        </button>
        <button
          className={filter === 'alert' ? 'active' : ''}
          onClick={() => setFilter('alert')}
        >
          Alertas
        </button>
      </div>

      {/* Ordenamiento */}
      <div className="sort-options">
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="date">Más Reciente</option>
          <option value="amount">Mayor Monto</option>
        </select>
      </div>

      {/* Tabla de Transacciones */}
      <table className="history-table">
        <thead>
          <tr>
            <th>Hora</th>
            <th>Tipo</th>
            <th>Descripción</th>
            <th>Monto</th>
            <th>Estado</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          {filteredTransactions.map(tx => (
            <TransactionRow
              key={tx.id}
              transaction={tx}
            />
          ))}
        </tbody>
      </table>

      {/* Exportar Historial */}
      <div className="export-section">
        <button onClick={() => exportToCSV()}>📥 Descargar CSV</button>
        <button onClick={() => exportToPDF()}>📄 Descargar PDF</button>
        <button onClick={() => emailHistory()}>📧 Enviar por Email</button>
      </div>
    </div>
  );
}

function TransactionRow({ transaction }) {
  const getTypeIcon = (type) => {
    switch (type) {
      case 'order': return '🍹';
      case 'tip': return '💝';
      case 'alert': return '⚠️';
      case 'refund': return '💰';
      default: return '📝';
    }
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'confirmed': return <span className="badge-success">✓ Confirmada</span>;
      case 'pending': return <span className="badge-warning">⏳ Pendiente</span>;
      case 'disputed': return <span className="badge-danger">⚠️ Disputada</span>;
      case 'refunded': return <span className="badge-info">💰 Reembolsada</span>;
      default: return <span className="badge-gray">-</span>;
    }
  };

  return (
    <tr className={`transaction-${transaction.status}`}>
      <td>{new Date(transaction.timestamp).toLocaleString()}</td>
      <td>
        <span className="type-icon">{getTypeIcon(transaction.type)}</span>
        {transaction.type}
      </td>
      <td>{transaction.description}</td>
      <td className="amount">${transaction.amount}</td>
      <td>{getStatusBadge(transaction.status)}</td>
      <td>
        <button className="btn-detail">Ver Detalles</button>
        {transaction.status === 'pending' && (
          <>
            <button className="btn-confirm">Confirmar</button>
            <button className="btn-reject">Rechazar</button>
          </>
        )}
        {transaction.status === 'confirmed' && (
          <button className="btn-dispute">Disputar</button>
        )}
      </td>
    </tr>
  );
}
```

---

## 💻 IMPLEMENTACIÓN TÉCNICA / TECHNICAL IMPLEMENTATION

### **Paso 1: Backend - Servicio de Facturación / Backend - Billing Service**

```javascript
// server/services/billingService.js

class BillingService {
  /**
   * Crear nueva factura
   * Create new bill
   */
  static async createBill(customerId, clubId) {
    const bill = {
      id: `bill-${Date.now()}`,
      customerId,
      clubId,
      createdAt: new Date(),
      items: [],
      total: 0,
      breakdown: {
        subtotal: 0,
        taxes: 0,
        tips: 0
      },
      status: 'active'
    };

    // Guardar en Redis
    await redis.setex(
      `bill:${customerId}:${clubId}`,
      3600, // 1 hora TTL
      JSON.stringify(bill)
    );

    return bill;
  }

  /**
   * Agregar orden a factura
   * Add order to bill
   */
  static async addOrderToBill(customerId, clubId, orderData) {
    const billKey = `bill:${customerId}:${clubId}`;
    let bill = await redis.get(billKey);

    if (!bill) {
      bill = await this.createBill(customerId, clubId);
    } else {
      bill = JSON.parse(bill);
    }

    // Calcular impuestos
    const taxes = orderData.price * 0.16; // 16% IVA
    const orderWithTaxes = {
      ...orderData,
      taxes,
      totalPrice: orderData.price + taxes
    };

    // Agregar a factura
    bill.items.push(orderWithTaxes);
    bill.breakdown.subtotal += orderData.price;
    bill.breakdown.taxes += taxes;
    bill.total = bill.breakdown.subtotal + bill.breakdown.taxes + bill.breakdown.tips;

    // Guardar actualizada
    await redis.setex(billKey, 3600, JSON.stringify(bill));

    // Notificar al cliente
    this.notifyCustomer(customerId, {
      type: 'order-confirmed',
      title: 'Nueva Orden',
      message: `${orderData.name} - $${orderData.price}`,
      newTotal: bill.total
    });

    return bill;
  }

  /**
   * Notificar al cliente
   * Notify customer
   */
  static async notifyCustomer(customerId, notification) {
    // Enviar push notification
    io.to(`customer:${customerId}`).emit('notification', notification);

    // Guardar en BD para historial
    await db.query(
      `INSERT INTO notifications 
      (customer_id, type, message, data, created_at)
      VALUES ($1, $2, $3, $4, NOW())`,
      [customerId, notification.type, notification.message, JSON.stringify(notification)]
    );
  }

  /**
   * Confirmar orden
   * Confirm order
   */
  static async confirmOrder(customerId, clubId, orderId) {
    const billKey = `bill:${customerId}:${clubId}`;
    const bill = JSON.parse(await redis.get(billKey));

    const order = bill.items.find(item => item.id === orderId);
    if (order) {
      order.confirmed = true;
      order.confirmedAt = new Date();

      await redis.setex(billKey, 3600, JSON.stringify(bill));

      // Notificar
      io.to(`customer:${customerId}`).emit('order-confirmed', { orderId });
    }

    return bill;
  }

  /**
   * Rechazar orden
   * Reject order
   */
  static async rejectOrder(customerId, clubId, orderId, reason) {
    const billKey = `bill:${customerId}:${clubId}`;
    const bill = JSON.parse(await redis.get(billKey));

    const orderIndex = bill.items.findIndex(item => item.id === orderId);
    if (orderIndex !== -1) {
      const order = bill.items[orderIndex];

      // Recalcular total
      bill.breakdown.subtotal -= order.price;
      bill.breakdown.taxes -= order.taxes;
      bill.total = bill.breakdown.subtotal + bill.breakdown.taxes + bill.breakdown.tips;

      // Remover orden
      bill.items.splice(orderIndex, 1);

      await redis.setex(billKey, 3600, JSON.stringify(bill));

      // Notificar
      io.to(`customer:${customerId}`).emit('order-rejected', {
        orderId,
        reason,
        newTotal: bill.total
      });

      // Alertar a soporte
      io.to('support').emit('order-dispute', {
        customerId,
        orderId,
        reason
      });
    }

    return bill;
  }
}

module.exports = BillingService;
```

---

**© 2024 EV2 CLANDESTINOZ - All Rights Reserved**

💳 **Sistema de facturación en vivo completamente implementado. / Live billing system fully implemented.** 🚀
