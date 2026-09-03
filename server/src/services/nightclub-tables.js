// EV2 Clandestinoz - Complete Table Mapping
// Based on actual floor plan provided

const TABLES = {
  // PLANTA BAJA (Ground Floor)
  planta_baja: {
    zona_roja: [
      {
        id: "t39",
        number: 39,
        section: "ZONA ROJA",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 390,
        y: 150,
        color: "#FF1493"
      },
      {
        id: "t40",
        number: 40,
        section: "ZONA ROJA",
        floor: "PLANTA BAJA",
        capacity: 8,
        type: "booth",
        status: "available",
        x: 430,
        y: 150,
        color: "#FF1493"
      },
      {
        id: "t41",
        number: 41,
        section: "ZONA ROJA",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 470,
        y: 150,
        color: "#FF1493"
      }
    ],
    
    zona_azul_left: [
      {
        id: "t1",
        number: 1,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 80,
        y: 280,
        color: "#00BFFF"
      },
      {
        id: "t2",
        number: 2,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 80,
        y: 320,
        color: "#00BFFF"
      },
      {
        id: "t3",
        number: 3,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 120,
        y: 280,
        color: "#00BFFF"
      },
      {
        id: "t4",
        number: 4,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 120,
        y: 320,
        color: "#00BFFF"
      },
      {
        id: "t14",
        number: 14,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 160,
        y: 300,
        color: "#00BFFF"
      }
    ],

    zona_diamante: [
      {
        id: "t5",
        number: 5,
        section: "ZONA DIAMANTE",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 60,
        y: 450,
        color: "#9D00FF"
      },
      {
        id: "t6",
        number: 6,
        section: "ZONA DIAMANTE",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 100,
        y: 450,
        color: "#9D00FF"
      },
      {
        id: "t7",
        number: 7,
        section: "ZONA DIAMANTE",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 140,
        y: 450,
        color: "#9D00FF"
      },
      {
        id: "t8",
        number: 8,
        section: "ZONA DIAMANTE",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 180,
        y: 450,
        color: "#9D00FF"
      },
      {
        id: "t36",
        number: 36,
        section: "ZONA DIAMANTE",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 90,
        y: 480,
        color: "#9D00FF"
      },
      {
        id: "t37",
        number: 37,
        section: "ZONA DIAMANTE",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 160,
        y: 480,
        color: "#9D00FF"
      },
      {
        id: "t38",
        number: 38,
        section: "ZONA DIAMANTE",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 230,
        y: 480,
        color: "#9D00FF"
      }
    ],

    vip_elevado: [
      {
        id: "t16",
        number: 16,
        section: "VIP ELEVADO",
        floor: "PLANTA BAJA",
        capacity: 10,
        type: "vip_booth",
        status: "available",
        x: 280,
        y: 500,
        color: "#FF1493",
        isPremium: true
      },
      {
        id: "t17",
        number: 17,
        section: "VIP ELEVADO",
        floor: "PLANTA BAJA",
        capacity: 10,
        type: "vip_booth",
        status: "available",
        x: 340,
        y: 500,
        color: "#FF1493",
        isPremium: true
      },
      {
        id: "t18",
        number: 18,
        section: "VIP ELEVADO",
        floor: "PLANTA BAJA",
        capacity: 10,
        type: "vip_booth",
        status: "available",
        x: 400,
        y: 500,
        color: "#FF1493",
        isPremium: true
      }
    ],

    zona_azul_right: [
      {
        id: "t32",
        number: 32,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 420,
        y: 300,
        color: "#00BFFF"
      },
      {
        id: "t33",
        number: 33,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 420,
        y: 420,
        color: "#00BFFF"
      },
      {
        id: "t16b",
        number: 16,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 460,
        y: 380,
        color: "#00BFFF"
      },
      {
        id: "t17b",
        number: 17,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 500,
        y: 380,
        color: "#00BFFF"
      },
      {
        id: "t18b",
        number: 18,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 540,
        y: 380,
        color: "#00BFFF"
      },
      {
        id: "t19b",
        number: 19,
        section: "ZONA AZUL",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 580,
        y: 380,
        color: "#00BFFF"
      }
    ],

    more_tables_lower: [
      {
        id: "t9",
        number: 9,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 60,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t10",
        number: 10,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 100,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t11",
        number: 11,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 140,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t12",
        number: 12,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 180,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t13",
        number: 13,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 220,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t20",
        number: 20,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 460,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t21",
        number: 21,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 500,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t22",
        number: 22,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 540,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t23",
        number: 23,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 580,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t24",
        number: 24,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 620,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t25",
        number: 25,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 660,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t26",
        number: 26,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 700,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t27",
        number: 27,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 740,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t28",
        number: 28,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 780,
        y: 520,
        color: "#FFD700"
      },
      {
        id: "t34",
        number: 34,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 260,
        y: 350,
        color: "#FFD700"
      },
      {
        id: "t35",
        number: 35,
        section: "ZONA BAJA",
        floor: "PLANTA BAJA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 340,
        y: 350,
        color: "#FFD700"
      }
    ]
  },

  // PLANTA ALTA (Upper Floor)
  planta_alta: {
    zona_rosa: [
      {
        id: "t42",
        number: 42,
        section: "ZONA ROSA",
        floor: "PLANTA ALTA",
        capacity: 8,
        type: "vip_booth",
        status: "available",
        x: 120,
        y: 180,
        color: "#FF1493",
        isPremium: true
      },
      {
        id: "t43",
        number: 43,
        section: "ZONA ROSA",
        floor: "PLANTA ALTA",
        capacity: 8,
        type: "vip_booth",
        status: "available",
        x: 120,
        y: 280,
        color: "#FF1493",
        isPremium: true
      },
      {
        id: "t44",
        number: 44,
        section: "ZONA ROSA",
        floor: "PLANTA ALTA",
        capacity: 8,
        type: "vip_booth",
        status: "available",
        x: 120,
        y: 380,
        color: "#FF1493",
        isPremium: true
      },
      {
        id: "t45",
        number: 45,
        section: "ZONA ROSA",
        floor: "PLANTA ALTA",
        capacity: 8,
        type: "vip_booth",
        status: "available",
        x: 120,
        y: 480,
        color: "#FF1493",
        isPremium: true
      }
    ],

    zona_celeste: [
      {
        id: "t46",
        number: 46,
        section: "ZONA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 460,
        y: 180,
        color: "#00BFFF"
      },
      {
        id: "t47",
        number: 47,
        section: "ZONA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 460,
        y: 250,
        color: "#00BFFF"
      },
      {
        id: "t48",
        number: 48,
        section: "ZONA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 460,
        y: 320,
        color: "#00BFFF"
      },
      {
        id: "t49",
        number: 49,
        section: "ZONA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 460,
        y: 390,
        color: "#00BFFF"
      },
      {
        id: "t50",
        number: 50,
        section: "ZONA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 6,
        type: "booth",
        status: "available",
        x: 460,
        y: 460,
        color: "#00BFFF"
      }
    ],

    bottom_tables: [
      {
        id: "t51",
        number: 51,
        section: "ZONA BAJA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 380,
        y: 520,
        color: "#00BFFF"
      },
      {
        id: "t52",
        number: 52,
        section: "ZONA BAJA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 440,
        y: 520,
        color: "#00BFFF"
      },
      {
        id: "t53",
        number: 53,
        section: "ZONA BAJA CELESTE",
        floor: "PLANTA ALTA",
        capacity: 4,
        type: "standard",
        status: "available",
        x: 500,
        y: 520,
        color: "#00BFFF"
      }
    ]
  },

  // Special Areas
  special_areas: [
    {
      id: "barra",
      name: "BARRA",
      type: "bar",
      description: "Main bar area",
      floor: "BOTH"
    },
    {
      id: "dance_floor",
      name: "DANCE FLOOR",
      type: "dance_area",
      description: "Central dance floor",
      floor: "BOTH"
    },
    {
      id: "dj_booth",
      name: "DJ BOOTH",
      type: "dj",
      description: "DJ station",
      floor: "PLANTA BAJA"
    },
    {
      id: "vip_area",
      name: "VIP AREA",
      type: "vip",
      description: "Premium VIP section",
      floor: "BOTH"
    },
    {
      id: "entrada",
      name: "ENTRADA",
      type: "entrance",
      description: "Main entrance",
      floor: "PLANTA ALTA"
    },
    {
      id: "wc_area",
      name: "WC AREA",
      type: "restroom",
      description: "Restrooms",
      floor: "PLANTA BAJA"
    }
  ]
};

// Helper functions
function getAllTables() {
  const allTables = [];
  Object.values(TABLES.planta_baja).forEach(section => {
    if (Array.isArray(section)) {
      allTables.push(...section);
    }
  });
  Object.values(TABLES.planta_alta).forEach(section => {
    if (Array.isArray(section)) {
      allTables.push(...section);
    }
  });
  return allTables;
}

function getTablesByFloor(floor) {
  return getAllTables().filter(t => t.floor === floor);
}

function getTablesBySection(section) {
  return getAllTables().filter(t => t.section === section);
}

function getTableById(tableId) {
  return getAllTables().find(t => t.id === tableId);
}

function getTablesByCapacity(minCapacity) {
  return getAllTables().filter(t => t.capacity >= minCapacity);
}

function getVIPTables() {
  return getAllTables().filter(t => t.isPremium === true);
}

function getAvailableTables() {
  return getAllTables().filter(t => t.status === "available");
}

module.exports = {
  TABLES,
  getAllTables,
  getTablesByFloor,
  getTablesBySection,
  getTableById,
  getTablesByCapacity,
  getVIPTables,
  getAvailableTables
};
