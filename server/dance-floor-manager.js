// Dance Floor Management System with POS Integration

class DanceFloorManager {
  constructor() {
    this.tables = [];
    this.grid = {
      cols: 10,
      rows: 8,
      cellSize: 80
    };
    this.initializeDanceFloor();
  }

  initializeDanceFloor() {
    // Start with empty dance floor
    this.tables = [];
  }

  // Add round table to dance floor
  addRoundTable(type, x, y) {
    const tableTypes = {
      small: { capacity: 4, price: 2500, radius: 40, color: "#00FF00" },
      medium: { capacity: 6, price: 3500, radius: 50, color: "#00FF00" },
      large: { capacity: 8, price: 4500, radius: 60, color: "#00FF00" },
      vip: { capacity: 10, price: 6000, radius: 70, color: "#FFD700" }
    };

    if (!tableTypes[type]) return null;

    const table = {
      id: `dance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: type,
      tableType: tableTypes[type],
      position: { x, y },
      guests: 0,
      status: "available",
      reservationId: null,
      createdAt: new Date()
    };

    this.tables.push(table);
    return table;
  }

  // Remove round table from dance floor
  removeRoundTable(tableId) {
    const index = this.tables.findIndex(t => t.id === tableId);
    if (index > -1) {
      const removed = this.tables[index];
      this.tables.splice(index, 1);
      return removed;
    }
    return null;
  }

  // Rearrange table position
  rearrangeTable(tableId, newX, newY) {
    const table = this.tables.find(t => t.id === tableId);
    if (table) {
      table.position = { x: newX, y: newY };
      return table;
    }
    return null;
  }

  // Get all dance floor tables
  getAllTables() {
    return this.tables;
  }

  // Get table by ID
  getTableById(tableId) {
    return this.tables.find(t => t.id === tableId);
  }

  // Update table status
  updateTableStatus(tableId, status, reservationId = null) {
    const table = this.tables.find(t => t.id === tableId);
    if (table) {
      table.status = status;
      if (reservationId) table.reservationId = reservationId;
      return table;
    }
    return null;
  }

  // Get available tables
  getAvailableTables() {
    return this.tables.filter(t => t.status === "available");
  }

  // Get available tables by capacity
  getTablesByCapacity(minCapacity) {
    return this.tables.filter(
      t => t.status === "available" && t.tableType.capacity >= minCapacity
    );
  }

  // Move guests to table
  seatGuests(tableId, guestCount) {
    const table = this.tables.find(t => t.id === tableId);
    if (table && guestCount <= table.tableType.capacity) {
      table.guests = guestCount;
      table.status = "occupied";
      return table;
    }
    return null;
  }

  // Release table
  releaseTable(tableId) {
    const table = this.tables.find(t => t.id === tableId);
    if (table) {
      table.guests = 0;
      table.status = "available";
      table.reservationId = null;
      return table;
    }
    return null;
  }

  // Export to POS format
  exportToPOS() {
    return {
      timestamp: new Date(),
      totalTables: this.tables.length,
      availableTables: this.getAvailableTables().length,
      occupiedTables: this.tables.filter(t => t.status === "occupied").length,
      tables: this.tables.map(t => ({
        id: t.id,
        type: t.type,
        capacity: t.tableType.capacity,
        price: t.tableType.price,
        position: t.position,
        guests: t.guests,
        status: t.status,
        reservationId: t.reservationId
      }))
    };
  }

  // Import from POS
  importFromPOS(posData) {
    try {
      this.tables = posData.tables.map(t => ({
        id: t.id,
        type: t.type,
        tableType: {
          capacity: t.capacity,
          price: t.price,
          radius: this.getRadiusByType(t.type),
          color: t.type === "vip" ? "#FFD700" : "#00FF00"
        },
        position: t.position,
        guests: t.guests,
        status: t.status,
        reservationId: t.reservationId,
        createdAt: new Date()
      }));
      return true;
    } catch (e) {
      console.error("POS Import Error:", e);
      return false;
    }
  }

  getRadiusByType(type) {
    const radiusMap = {
      small: 40,
      medium: 50,
      large: 60,
      vip: 70
    };
    return radiusMap[type] || 50;
  }

  // Calculate dance floor occupancy
  getOccupancyStats() {
    const total = this.tables.length;
    const occupied = this.tables.filter(t => t.status === "occupied").length;
    const available = this.tables.filter(t => t.status === "available").length;
    const totalCapacity = this.tables.reduce((sum, t) => sum + t.tableType.capacity, 0);
    const seatedGuests = this.tables.reduce((sum, t) => sum + t.guests, 0);

    return {
      totalTables: total,
      occupiedTables: occupied,
      availableTables: available,
      occupancyPercent: total > 0 ? Math.round((occupied / total) * 100) : 0,
      totalCapacity: totalCapacity,
      seatedGuests: seatedGuests,
      capacityPercent: totalCapacity > 0 ? Math.round((seatedGuests / totalCapacity) * 100) : 0,
      revenue: this.calculateRevenue()
    };
  }

  calculateRevenue() {
    return this.tables.reduce((sum, t) => {
      return sum + (t.status === "occupied" ? t.tableType.price : 0);
    }, 0);
  }
}

module.exports = DanceFloorManager;
