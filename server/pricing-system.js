// EV2 Clandestinoz - Complete Pricing System

const PRICING = {
  currency: "MXN",
  currencySymbol: "$",
  
  zones: {
    // PLANTA BAJA
    zona_roja: {
      id: "zona_roja",
      name: "ZONA ROJA",
      floor: "PLANTA BAJA",
      color: "#FF1493",
      basePrice: 5000,
      capacity: 8,
      includes: [
        "8 personas base",
        "Ningún extra incluido",
        "Acceso a la pista de baile"
      ],
      extras: {
        per_person: 500,
        bottle_service: 1200,
        bottle_champagne: 1800
      }
    },

    zona_azul: {
      id: "zona_azul",
      name: "ZONA AZUL",
      floor: "PLANTA BAJA",
      color: "#00BFFF",
      basePrice: 4500,
      capacity: 10,
      includes: [
        "10 personas base",
        "2 extras incluidos",
        "Acceso VIP a la barra"
      ],
      extras: {
        per_person: 450,
        bottle_service: 1100,
        bottle_champagne: 1700
      }
    },

    zona_rosa: {
      id: "zona_rosa",
      name: "ZONA ROSA",
      floor: "PLANTA ALTA",
      color: "#FF1493",
      basePrice: 4000,
      capacity: 6,
      includes: [
        "6 personas base",
        "2 extras incluidos",
        "Acceso a lounge"
      ],
      extras: {
        per_person: 400,
        bottle_service: 1000,
        bottle_champagne: 1600
      }
    },

    celebration_suite: {
      id: "celebration_suite",
      name: "CELEBRATION SUITE",
      floor: "PLANTA ALTA",
      color: "#FFD700",
      basePrice: 8000,
      capacity: 8,
      includes: [
        "8 personas base",
        "2 extras incluidos",
        "Acceso PREMIUM",
        "Personal dedicado"
      ],
      extras: {
        per_person: 800,
        bottle_service: 1400,
        bottle_champagne: 2000
      },
      isPremium: true
    },

    vip_elevado: {
      id: "vip_elevado",
      name: "VIP ELEVADO",
      floor: "PLANTA BAJA",
      color: "#FF1493",
      basePrice: 6000,
      capacity: 8,
      includes: [
        "8 personas base",
        "2 extras incluidos",
        "Acceso ELEVADO VIP"
      ],
      extras: {
        per_person: 600,
        bottle_service: 1250,
        bottle_champagne: 1850
      },
      isPremium: true
    },

    zona_diamante: {
      id: "zona_diamante",
      name: "ZONA DIAMANTE",
      floor: "PLANTA BAJA",
      color: "#9D00FF",
      basePrice: 5000,
      capacity: 6,
      includes: [
        "6 personas base",
        "2 extras incluidos",
        "Acceso premium"
      ],
      extras: {
        per_person: 500,
        bottle_service: 1200,
        bottle_champagne: 1800
      }
    },

    zona_doble_diamante: {
      id: "zona_doble_diamante",
      name: "ZONA DOBLE DIAMANTE",
      floor: "PLANTA BAJA",
      color: "#9D00FF",
      basePrice: 6000,
      capacity: 6,
      includes: [
        "6 personas base",
        "2 extras incluidos",
        "Doble acceso premium"
      ],
      extras: {
        per_person: 600,
        bottle_service: 1300,
        bottle_champagne: 1900
      }
    },

    zona_doble_diamante_vip: {
      id: "zona_doble_diamante_vip",
      name: "ZONA DOBLE DIAMANTE VIP",
      floor: "PLANTA BAJA",
      color: "#9D00FF",
      basePrice: 8000,
      capacity: 10,
      includes: [
        "10 personas base",
        "2 extras incluidos",
        "VIP VIP acceso"
      ],
      extras: {
        per_person: 800,
        bottle_service: 1500,
        bottle_champagne: 2100
      },
      isPremium: true
    },

    zona_noble_diamante: {
      id: "zona_noble_diamante",
      name: "ZONA NOBLE DIAMANTE",
      floor: "PLANTA ALTA",
      color: "#9D00FF",
      basePrice: 6000,
      capacity: 6,
      includes: [
        "6 personas base",
        "2 extras incluidos",
        "Acceso NOBLE"
      ],
      extras: {
        per_person: 600,
        bottle_service: 1300,
        bottle_champagne: 1900
      }
    }
  },

  // Dance Floor Round Tables - Dynamic
  dance_floor_tables: {
    small_round: {
      id: "round_small",
      name: "Round Table (Small)",
      capacity: 4,
      basePrice: 2500,
      color: "#00FF00",
      includes: ["4 personas", "Posición privilegiada"],
      extras: {
        per_person: 250,
        bottle_service: 800,
        bottle_champagne: 1400
      }
    },
    medium_round: {
      id: "round_medium",
      name: "Round Table (Medium)",
      capacity: 6,
      basePrice: 3500,
      color: "#00FF00",
      includes: ["6 personas", "Mejor vista"],
      extras: {
        per_person: 350,
        bottle_service: 1000,
        bottle_champagne: 1600
      }
    },
    large_round: {
      id: "round_large",
      name: "Round Table (Large)",
      capacity: 8,
      basePrice: 4500,
      color: "#00FF00",
      includes: ["8 personas", "Centro de la pista"],
      extras: {
        per_person: 450,
        bottle_service: 1200,
        bottle_champagne: 1800
      }
    },
    vip_round: {
      id: "round_vip",
      name: "Round Table VIP",
      capacity: 10,
      basePrice: 6000,
      color: "#FFD700",
      includes: ["10 personas", "VIP en pista", "Personal dedicado"],
      extras: {
        per_person: 600,
        bottle_service: 1400,
        bottle_champagne: 2000
      },
      isPremium: true
    }
  },

  // Bottle Service
  bottles: {
    house_wine: {
      name: "Vino de la Casa",
      price: 400,
      servings: 4
    },
    premium_wine: {
      name: "Vino Premium",
      price: 700,
      servings: 4
    },
    champagne: {
      name: "Champagne",
      price: 1200,
      servings: 4
    },
    vodka_bottle: {
      name: "Vodka Botella",
      price: 1400,
      servings: 8
    },
    tequila_bottle: {
      name: "Tequila Botella",
      price: 1100,
      servings: 8
    },
    rum_bottle: {
      name: "Ron Botella",
      price: 1200,
      servings: 8
    }
  },

  // Add-ons
  addons: {
    sparklers: {
      name: "Sparklers (Bengalas)",
      price: 300,
      description: "Fuego en la botella"
    },
    decoration_upgrade: {
      name: "Upgrade Decoración",
      price: 500,
      description: "Globos y decoraciones EV2"
    },
    bottle_service_premium: {
      name: "Premium Bottle Service",
      price: 800,
      description: "Servicio de botella con mesero dedicado"
    },
    vip_wristband: {
      name: "Pulsera VIP",
      price: 100,
      description: "Acceso VIP todo la noche"
    },
    photo_booth: {
      name: "Photo Booth",
      price: 600,
      description: "Fotos con fondo EV2"
    },
    dj_shoutout: {
      name: "DJ Shout-out",
      price: 400,
      description: "El DJ te saluda"
    },
    reserved_parking: {
      name: "Estacionamiento VIP",
      price: 150,
      description: "Lugar reservado"
    },
    vip_coat_check: {
      name: "Coat Check VIP",
      price: 50,
      description: "Cuidado de abrigos"
    }
  },

  // Pricing Rules
  rules: {
    minDeposit: 0.30, // 30%
    cancellation_policy_hours: 24,
    extra_hour_price: 1000,
    group_discount_threshold: 20,
    group_discount_percent: 10,
    weekend_multiplier: 1.2, // Friday-Saturday +20%
    holiday_multiplier: 1.5
  }
};

// Helper Functions
function getZonePrice(zoneId, guestCount = null) {
  const zone = PRICING.zones[zoneId];
  if (!zone) return null;
  
  let total = zone.basePrice;
  
  if (guestCount && guestCount > zone.capacity) {
    const extras = guestCount - zone.capacity;
    total += extras * zone.extras.per_person;
  }
  
  return total;
}

function getDanceFloorPrice(tableType, guestCount = null) {
  const table = PRICING.dance_floor_tables[tableType];
  if (!table) return null;
  
  let total = table.basePrice;
  
  if (guestCount && guestCount > table.capacity) {
    const extras = guestCount - table.capacity;
    total += extras * table.extras.per_person;
  }
  
  return total;
}

function calculateReservationTotal(zoneId, guestCount, durationHours = 3, addons = []) {
  const basePrice = getZonePrice(zoneId, guestCount);
  if (!basePrice) return null;
  
  let total = basePrice;
  
  // Add extra hours (beyond 3 hours base)
  if (durationHours > 3) {
    const extraHours = durationHours - 3;
    total += extraHours * PRICING.rules.extra_hour_price;
  }
  
  // Add selected add-ons
  addons.forEach(addonId => {
    const addon = Object.values(PRICING.addons).find(a => a.name === addonId);
    if (addon) total += addon.price;
  });
  
  // Apply weekend multiplier
  const today = new Date();
  if (today.getDay() === 5 || today.getDay() === 6) {
    total *= PRICING.rules.weekend_multiplier;
  }
  
  return Math.round(total);
}

function calculateDeposit(total) {
  return Math.round(total * PRICING.rules.minDeposit);
}

module.exports = {
  PRICING,
  getZonePrice,
  getDanceFloorPrice,
  calculateReservationTotal,
  calculateDeposit
};
