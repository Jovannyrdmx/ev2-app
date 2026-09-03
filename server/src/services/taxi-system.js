// EV2 Clandestinoz - Taxi System & Safe Departure Code

class TaxiSystem {
  constructor() {
    this.taxis = [];
    this.rides = [];
    this.conductCodes = [];
    this.locations = {
      ev2_clandestinoz: {
        name: "EV2 Clandestinoz",
        address: "Nogales, Sonora, Mexico",
        latitude: 31.3505,
        longitude: -110.9265,
        phone: "+52-641-XXXX-XXXX"
      }
    };
  }

  // Taxi Service Providers (Nogales, Sonora)
  TAXI_SERVICES = {
    sitio_1: {
      id: "sitio_1",
      name: "Sitio de Taxis Central",
      phone: "+52-641-314-0000",
      rating: 4.8,
      available: true,
      response_time: "5-10 min"
    },
    sitio_2: {
      id: "sitio_2",
      name: "Radio Taxi Nogales",
      phone: "+52-641-313-5555",
      rating: 4.6,
      available: true,
      response_time: "8-12 min"
    },
    sitio_3: {
      id: "sitio_3",
      name: "Taxis Seguros Nogales",
      phone: "+52-641-312-1111",
      rating: 4.9,
      available: true,
      response_time: "6-10 min"
    },
    uber: {
      id: "uber",
      name: "Uber (Mexico)",
      available: true,
      response_time: "5-15 min"
    },
    indriver: {
      id: "indriver",
      name: "InDriver (Mexico)",
      available: true,
      response_time: "5-15 min"
    },
    beat: {
      id: "beat",
      name: "Beat (Mexico)",
      available: true,
      response_time: "5-15 min"
    }
  };

  // Generate Safe Conduct Code (válido en México)
  generateConductCode(userId, userName, currentDate = new Date()) {
    // Code format: EV2-[DATE]-[HOUR]-[RANDOM]-[MX]
    const date = currentDate.getDate().toString().padStart(2, '0');
    const month = (currentDate.getMonth() + 1).toString().padStart(2, '0');
    const hour = currentDate.getHours().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 9000 + 1000); // 1000-9999
    
    const code = `EV2-${month}${date}-${hour}00-${random}-MX`;
    
    const conductCode = {
      id: `code_${Date.now()}`,
      code: code,
      userId: userId,
      userName: userName,
      generatedAt: currentDate,
      expiresAt: new Date(currentDate.getTime() + 45 * 60000), // 45 minutes
      status: "active",
      usageCount: 0,
      location: "Nogales, Sonora, Mexico",
      validity: "45 minutes from issuance",
      description: "Proof of Respectful Conduct - Válido en México",
      terms: [
        "This code proves you left EV2 Clandestinoz in good standing",
        "Valid for 45 minutes from issuance",
        "Valid only in Nogales, Sonora, Mexico",
        "Show to law enforcement if requested",
        "IMPORTANT: Code only valid if behaving respectfully",
        "Respect the code, be respectful at all times",
        "Violation of conduct = code becomes invalid"
      ],
      conductExpectations: [
        "No aggressive behavior",
        "No intoxicated driving",
        "Follow traffic laws",
        "Respect others",
        "Be courteous to officers"
      ],
      warningText: "⚠️ IF YOU ARE NOT BEHAVING AND CAUSING TROUBLE YOU WILL BE ARRESTED - RESPECT THE CODE AND BE RESPECTFUL"
    };

    this.conductCodes.push(conductCode);
    return conductCode;
  }

  // Request Taxi
  requestTaxi(userId, serviceType, destination = "Nogales, Sonora") {
    const service = this.TAXI_SERVICES[serviceType];
    if (!service) return { error: "Service not available" };

    const ride = {
      id: `ride_${Date.now()}`,
      userId: userId,
      serviceType: serviceType,
      serviceName: service.name,
      servicePhone: service.phone,
      pickupLocation: this.locations.ev2_clandestinoz,
      destination: destination,
      requestedAt: new Date(),
      status: "requested", // requested, confirmed, en_route, arrived, completed
      estimatedArrival: `${service.response_time}`,
      conductCode: null,
      rating: 0,
      notes: ""
    };

    this.rides.push(ride);
    return {
      success: true,
      ride: ride,
      service: service,
      message: `Taxi requested from ${service.name}. Expected arrival: ${service.response_time}`
    };
  }

  // Confirm Ride & Generate Conduct Code
  confirmRide(rideId, userId) {
    const ride = this.rides.find(r => r.id === rideId && r.userId === userId);
    if (!ride) return { error: "Ride not found" };

    // Generate conduct code for this user
    const conductCode = this.generateConductCode(userId, "Club Guest", new Date());
    
    ride.status = "confirmed";
    ride.conductCode = conductCode.code;
    ride.confirmationTime = new Date();

    return {
      success: true,
      ride: ride,
      conductCode: conductCode,
      message: "Ride confirmed. Your safe conduct code is ready."
    };
  }

  // Get Conduct Code
  getConductCode(userId) {
    const codes = this.conductCodes.filter(c => c.userId === userId && c.status === "active");
    
    if (codes.length === 0) return { error: "No active conduct codes" };

    // Sort by newest first
    codes.sort((a, b) => b.generatedAt - a.generatedAt);
    return codes[0];
  }

  // Validate Conduct Code (for officers)
  validateConductCode(code) {
    const conductCode = this.conductCodes.find(c => c.code === code);
    
    if (!conductCode) {
      return {
        valid: false,
        message: "Code not found in system",
        action: "Contact EV2 Clandestinoz for verification"
      };
    }

    const now = new Date();
    const isExpired = now > conductCode.expiresAt;
    const isActive = conductCode.status === "active";

    return {
      valid: isActive && !isExpired,
      code: conductCode.code,
      generatedAt: conductCode.generatedAt,
      expiresAt: conductCode.expiresAt,
      location: conductCode.location,
      userName: conductCode.userName,
      status: conductCode.status,
      message: isExpired ? "Code has expired" : isActive ? "Code is valid" : "Code is no longer active",
      timestamp: now,
      verifiedAt: now
    };
  }

  // Complete Ride & Rate
  completeRide(rideId, userId, rating = 5, notes = "") {
    const ride = this.rides.find(r => r.id === rideId && r.userId === userId);
    if (!ride) return { error: "Ride not found" };

    ride.status = "completed";
    ride.completedAt = new Date();
    ride.rating = rating;
    ride.notes = notes;

    // Conduct code remains valid for full 45 minutes from generation
    const conductCode = this.conductCodes.find(c => c.code === ride.conductCode);
    if (conductCode) {
      conductCode.rideCompleted = true;
      conductCode.completedAt = new Date();
    }

    return {
      success: true,
      ride: ride,
      message: "Ride completed. Thank you for choosing EV2 safe departure service."
    };
  }

  // Get All Active Rides for User
  getUserRides(userId) {
    return this.rides.filter(r => r.userId === userId && r.status !== "completed");
  }

  // Emergency Contact
  getEmergencyContacts() {
    return {
      police: {
        name: "Policía Municipal Nogales",
        number: "911 or +52-641-315-1111",
        type: "Emergency"
      },
      clinica: {
        name: "Clínica Hospital ISSSTE",
        number: "+52-641-314-2000",
        type: "Medical Emergency"
      },
      taxi_emergency: {
        name: "Safe Taxi Services",
        number: "+52-641-314-0000",
        type: "Safe Ride"
      }
    };
  }

  // Safety Info
  getSafetyInfo() {
    return {
      title: "EV2 Safe Departure Program",
      overview: "Free taxi coordination and safe conduct verification for guests leaving EV2 Clandestinoz",
      location: "Nogales, Sonora, Mexico",
      how_it_works: [
        "1. At club exit, press 'Request Taxi' button on app",
        "2. Choose from 6 taxi/ride services",
        "3. Request confirmed → receive conduct code",
        "4. Code valid for 45 minutes from generation",
        "5. Show code to officers if pulled over",
        "6. Code proves you left respectfully"
      ],
      conduct_code_info: {
        format: "EV2-MMDD-HH00-XXXX-MX",
        validity: "45 minutes from generation",
        valid_in: "Nogales, Sonora, Mexico",
        what_it_proves: "Guest left EV2 in good standing and behaving respectfully",
        who_accepts: "Mexican law enforcement, local police"
      },
      important_note: "⚠️ IF YOU ARE NOT BEHAVING AND CAUSING TROUBLE YOU WILL BE ARRESTED - RESPECT THE CODE AND BE RESPECTFUL",
      available_services: [
        "Sitio de Taxis Central - +52-641-314-0000",
        "Radio Taxi Nogales - +52-641-313-5555",
        "Taxis Seguros Nogales - +52-641-312-1111",
        "Uber (Mexico app)",
        "InDriver (Mexico app)",
        "Beat (Mexico app)"
      ],
      conduct_expectations: {
        do: [
          "Be respectful to fellow guests",
          "Follow club rules",
          "Respect staff and security",
          "Keep noise levels appropriate",
          "Leave belongings with coat check"
        ],
        dont: [
          "No aggressive behavior",
          "No harassing other guests",
          "No damaging property",
          "No intoxicated behavior beyond capacity",
          "No causing trouble of any kind"
        ]
      },
      legal_note: "This safe conduct code is valid in México (Mexico). Violation of conduct expectations may result in code revocation and local law enforcement involvement."
    };
  }

  // Get Conduct Code as QR-Safe String for display
  getCodeDisplayFormat(conductCode) {
    return {
      fullCode: conductCode.code,
      displayCode: `${conductCode.code.substring(0, 10)}...${conductCode.code.substring(20)}`,
      expiryCountdown: `${Math.floor((conductCode.expiresAt - new Date()) / 60000)} min remaining`,
      qrData: conductCode.code, // Can be used to generate QR code
      printable: `
        ╔═════════════════════════════════════════════╗
        ║     EV2 CLANDESTINOZ SAFE CONDUCT CODE      ║
        ║          Válido en México                   ║
        ╠═════════════════════════════════════════════╣
        ║ Code: ${conductCode.code}
        ║ Guest: ${conductCode.userName}
        ║ Generated: ${conductCode.generatedAt.toLocaleString()}
        ║ Expires: ${conductCode.expiresAt.toLocaleString()}
        ║ Valid for: 45 minutes
        ║ Location: Nogales, Sonora, Mexico
        ╠═════════════════════════════════════════════╣
        ║ SHOW THIS TO OFFICERS IF REQUESTED          ║
        ║ This proves you left EV2 in good standing   ║
        ║ Respect the code, be respectful at all times║
        ╠═════════════════════════════════════════════╣
        ║ ⚠️  WARNING ⚠️                              ║
        ║ IF YOU ARE NOT BEHAVING AND CAUSING        ║
        ║ TROUBLE YOU WILL BE ARRESTED               ║
        ║ RESPECT THE CODE AND BE RESPECTFUL         ║
        ╚═════════════════════════════════════════════╝
      `
    };
  }
}

module.exports = TaxiSystem;
