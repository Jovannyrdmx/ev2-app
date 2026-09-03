// EV2 Clandestinoz - Valet Parking Management System

class ValetParkingSystem {
  constructor() {
    this.valets = [];
    this.vehicles = [];
    this.parkingSpots = [];
    this.valetEarnings = {};
    this.transactions = [];
    this.valetRatings = {};
  }

  // Register Valet
  registerValet(valetData) {
    if (!valetData.firstName || !valetData.lastName || !valetData.email || !valetData.phone) {
      return { success: false, error: 'All fields required' };
    }

    const valet = {
      id: `valet_${Date.now()}`,
      firstName: valetData.firstName,
      lastName: valetData.lastName,
      email: valetData.email,
      phone: valetData.phone,
      licenseNumber: valetData.licenseNumber || null,
      licenseExpiry: valetData.licenseExpiry || null,
      insuranceCertificate: valetData.insuranceCertificate || null,
      status: 'active',
      registeredAt: new Date(),
      totalEarnings: 0,
      carsParked: 0,
      averageRating: 5.0,
      totalRatings: 0
    };

    this.valets.push(valet);
    this.valetEarnings[valet.id] = {
      tips: 0,
      fees: 0,
      total: 0,
      transactions: []
    };
    this.valetRatings[valet.id] = [];

    return { success: true, valet: valet };
  }

  // Check In Vehicle
  checkInVehicle(valetId, vehicleData) {
    const valet = this.valets.find(v => v.id === valetId);
    if (!valet) return { success: false, error: 'Valet not found' };

    // Find available parking spot
    const availableSpot = this.parkingSpots.find(s => s.available);
    if (!availableSpot) return { success: false, error: 'No parking spots available' };

    const vehicle = {
      id: `vehicle_${Date.now()}`,
      valetId: valetId,
      valetName: `${valet.firstName} ${valet.lastName}`,
      guestName: vehicleData.guestName,
      guestPhone: vehicleData.guestPhone,
      licencePlate: vehicleData.licencePlate,
      make: vehicleData.make,
      model: vehicleData.model,
      color: vehicleData.color,
      parkingSpot: availableSpot.spotNumber,
      spotDetails: availableSpot.details,
      checkInTime: new Date(),
      checkOutTime: null,
      notes: vehicleData.notes || '',
      status: 'parked', // 'parked', 'requested', 'retrieved'
      valetRating: null,
      tip: 0,
      totalCost: 0
    };

    this.vehicles.push(vehicle);
    availableSpot.available = false;
    availableSpot.vehicle = vehicle.id;

    valet.carsParked += 1;

    return { success: true, vehicle: vehicle };
  }

  // Request Vehicle
  requestVehicle(vehicleId) {
    const vehicle = this.vehicles.find(v => v.id === vehicleId);
    if (!vehicle) return { success: false, error: 'Vehicle not found' };

    if (vehicle.status !== 'parked') {
      return { success: false, error: 'Vehicle already requested or retrieved' };
    }

    vehicle.status = 'requested';
    vehicle.requestTime = new Date();

    return { success: true, vehicle: vehicle, message: 'Vehicle retrieval requested' };
  }

  // Check Out Vehicle (Calculate Cost)
  checkOutVehicle(vehicleId, parkingFee, tip = 0, rating = 5, valetRatingComment = '') {
    const vehicle = this.vehicles.find(v => v.id === vehicleId);
    if (!vehicle) return { success: false, error: 'Vehicle not found' };

    vehicle.checkOutTime = new Date();
    vehicle.status = 'retrieved';
    vehicle.tip = tip;
    vehicle.totalCost = parkingFee + tip;
    vehicle.valetRating = rating;
    vehicle.valetRatingComment = valetRatingComment;

    // Calculate parking duration
    const durationMs = vehicle.checkOutTime - vehicle.checkInTime;
    const durationHours = Math.ceil(durationMs / (1000 * 60 * 60));

    const valet = this.valets.find(v => v.id === vehicle.valetId);
    if (valet) {
      valet.totalEarnings += (parkingFee + tip);

      // Update earnings
      this.valetEarnings[valet.id].tips += tip;
      this.valetEarnings[valet.id].fees += parkingFee;
      this.valetEarnings[valet.id].total += (parkingFee + tip);

      // Update rating
      if (!this.valetRatings[valet.id]) this.valetRatings[valet.id] = [];
      this.valetRatings[valet.id].push({
        rating: rating,
        comment: valetRatingComment,
        timestamp: new Date()
      });

      // Recalculate average rating
      const allRatings = this.valetRatings[valet.id];
      const avgRating = allRatings.reduce((sum, r) => sum + r.rating, 0) / allRatings.length;
      valet.averageRating = avgRating;
      valet.totalRatings = allRatings.length;
    }

    // Free up parking spot
    const spot = this.parkingSpots.find(s => s.vehicle === vehicleId);
    if (spot) {
      spot.available = true;
      spot.vehicle = null;
    }

    // Create transaction record
    const transaction = {
      id: `valet_txn_${Date.now()}`,
      valetId: vehicle.valetId,
      valetName: vehicle.valetName,
      vehicleId: vehicleId,
      guestName: vehicle.guestName,
      licencePlate: vehicle.licencePlate,
      parkingFee: parkingFee,
      tip: tip,
      totalCost: parkingFee + tip,
      durationHours: durationHours,
      rating: rating,
      checkInTime: vehicle.checkInTime,
      checkOutTime: vehicle.checkOutTime,
      timestamp: new Date()
    };

    this.transactions.push(transaction);
    this.valetEarnings[vehicle.valetId].transactions.push(transaction);

    return {
      success: true,
      vehicle: vehicle,
      transaction: transaction,
      earnings: {
        parkingFee: parkingFee,
        tip: tip,
        total: parkingFee + tip
      }
    };
  }

  // Initialize Parking Spots
  initializeParkingSpots(totalSpots = 50) {
    this.parkingSpots = [];
    
    for (let i = 1; i <= totalSpots; i++) {
      const spot = {
        spotNumber: i,
        details: `Spot ${i}`,
        available: true,
        vehicle: null,
        level: Math.ceil(i / 25), // 2 levels, 25 spots each
        accessible: (i % 5 === 0) // Every 5th spot is accessible
      };
      this.parkingSpots.push(spot);
    }

    return { success: true, message: `${totalSpots} parking spots initialized` };
  }

  // Get Valet Dashboard
  getValetDashboard(valetId) {
    const valet = this.valets.find(v => v.id === valetId);
    if (!valet) return { success: false, error: 'Valet not found' };

    const earnings = this.valetEarnings[valetId];
    const ratings = this.valetRatings[valetId] || [];

    return {
      success: true,
      valet: {
        id: valet.id,
        name: `${valet.firstName} ${valet.lastName}`,
        email: valet.email,
        phone: valet.phone,
        status: valet.status,
        carsParked: valet.carsParked,
        averageRating: valet.averageRating,
        totalRatings: valet.totalRatings
      },
      earnings: {
        totalTips: earnings.tips,
        totalFees: earnings.fees,
        totalEarnings: earnings.total,
        averageEarningsPerCar: earnings.total / valet.carsParked || 0
      },
      recentTransactions: earnings.transactions.slice(-10),
      recentRatings: ratings.slice(-5)
    };
  }

  // Get Parking Status
  getParkingStatus() {
    const totalSpots = this.parkingSpots.length;
    const occupiedSpots = this.parkingSpots.filter(s => !s.available).length;
    const availableSpots = this.parkingSpots.filter(s => s.available).length;

    return {
      totalSpots: totalSpots,
      occupiedSpots: occupiedSpots,
      availableSpots: availableSpots,
      occupancyRate: ((occupiedSpots / totalSpots) * 100).toFixed(1) + '%',
      vehicles: this.vehicles.filter(v => v.status === 'parked'),
      requestedVehicles: this.vehicles.filter(v => v.status === 'requested')
    };
  }

  // Get Valet Performance Report
  getValetPerformanceReport(valetId) {
    const valet = this.valets.find(v => v.id === valetId);
    if (!valet) return { success: false, error: 'Valet not found' };

    const earnings = this.valetEarnings[valetId];
    const ratings = this.valetRatings[valetId] || [];

    return {
      success: true,
      valetId: valet.id,
      valetName: `${valet.firstName} ${valet.lastName}`,
      totalCarsParked: valet.carsParked,
      totalEarnings: earnings.total,
      totalTips: earnings.tips,
      totalFees: earnings.fees,
      averageTipPerCar: earnings.tips / valet.carsParked || 0,
      averageFeePerCar: earnings.fees / valet.carsParked || 0,
      averageEarningsPerCar: earnings.total / valet.carsParked || 0,
      averageRating: valet.averageRating,
      totalRatings: valet.totalRatings,
      ratingBreakdown: this.calculateRatingBreakdown(valetId),
      performanceScore: this.calculatePerformanceScore(valetId)
    };
  }

  // Calculate Rating Breakdown
  calculateRatingBreakdown(valetId) {
    const ratings = this.valetRatings[valetId] || [];
    const breakdown = {
      '5': 0,
      '4': 0,
      '3': 0,
      '2': 0,
      '1': 0
    };

    ratings.forEach(r => {
      breakdown[r.rating]++;
    });

    return breakdown;
  }

  // Calculate Performance Score (0-100)
  calculatePerformanceScore(valetId) {
    const valet = this.valets.find(v => v.id === valetId);
    if (!valet) return 0;

    const ratingScore = (valet.averageRating / 5) * 50; // 50 points for rating
    const volumeScore = Math.min((valet.carsParked / 100) * 30, 30); // 30 points for volume
    const earningsScore = Math.min((valet.totalEarnings / 5000) * 20, 20); // 20 points for earnings

    return Math.round(ratingScore + volumeScore + earningsScore);
  }

  // Get All Valets Leaderboard
  getValetsLeaderboard(limit = 10) {
    return this.valets
      .sort((a, b) => b.totalEarnings - a.totalEarnings)
      .slice(0, limit)
      .map(valet => ({
        id: valet.id,
        name: `${valet.firstName} ${valet.lastName}`,
        carsParked: valet.carsParked,
        totalEarnings: valet.totalEarnings,
        averageRating: valet.averageRating,
        totalRatings: valet.totalRatings,
        performanceScore: this.calculatePerformanceScore(valet.id)
      }));
  }

  // Pricing Configuration
  getPricingTiers() {
    return {
      standard: {
        name: 'Standard Valet',
        basePrice: 150, // MXN
        duration: '2 hours',
        description: 'Standard parking service'
      },
      premium: {
        name: 'Premium Valet',
        basePrice: 300,
        duration: '4 hours',
        description: 'Premium valet with vehicle tracking'
      },
      allNight: {
        name: 'All Night Valet',
        basePrice: 500,
        duration: '8+ hours',
        description: 'Full night valet service'
      },
      vip: {
        name: 'VIP Valet',
        basePrice: 750,
        duration: 'Unlimited',
        description: 'VIP treatment with car watch'
      }
    };
  }

  // Vehicle Tracking
  trackVehicle(vehicleId) {
    const vehicle = this.vehicles.find(v => v.id === vehicleId);
    if (!vehicle) return { success: false, error: 'Vehicle not found' };

    const valet = this.valets.find(v => v.id === vehicle.valetId);

    return {
      success: true,
      vehicleTracking: {
        vehicleId: vehicleId,
        licencePlate: vehicle.licencePlate,
        make: vehicle.make,
        model: vehicle.model,
        color: vehicle.color,
        parkingSpot: vehicle.parkingSpot,
        spotDetails: vehicle.spotDetails,
        valetName: vehicle.valetName,
        valetPhone: valet ? valet.phone : null,
        checkInTime: vehicle.checkInTime,
        status: vehicle.status,
        notes: vehicle.notes
      }
    };
  }

  // Generate Valet Shift Report
  generateShiftReport(date) {
    const dayTransactions = this.transactions.filter(t => 
      new Date(t.timestamp).toDateString() === date.toDateString()
    );

    const totalEarnings = dayTransactions.reduce((sum, t) => sum + t.totalCost, 0);
    const totalTips = dayTransactions.reduce((sum, t) => sum + t.tip, 0);
    const totalFees = dayTransactions.reduce((sum, t) => sum + t.parkingFee, 0);
    const averageRating = dayTransactions.length > 0 
      ? (dayTransactions.reduce((sum, t) => sum + t.rating, 0) / dayTransactions.length).toFixed(2)
      : 0;

    return {
      date: date.toDateString(),
      totalTransactions: dayTransactions.length,
      totalEarnings: totalEarnings,
      totalTips: totalTips,
      totalFees: totalFees,
      averageRating: averageRating,
      averageEarningsPerCar: (totalEarnings / dayTransactions.length).toFixed(2),
      topValet: this.getTopValetByDay(dayTransactions),
      transactions: dayTransactions
    };
  }

  // Get Top Valet by Day
  getTopValetByDay(dayTransactions) {
    const valetStats = {};
    
    dayTransactions.forEach(t => {
      if (!valetStats[t.valetId]) {
        valetStats[t.valetId] = {
          name: t.valetName,
          earnings: 0,
          cars: 0,
          rating: 0
        };
      }
      valetStats[t.valetId].earnings += t.totalCost;
      valetStats[t.valetId].cars += 1;
      valetStats[t.valetId].rating += t.rating;
    });

    let topValet = null;
    let maxEarnings = 0;

    for (const [, stats] of Object.entries(valetStats)) {
      if (stats.earnings > maxEarnings) {
        maxEarnings = stats.earnings;
        topValet = stats;
      }
    }

    return topValet;
  }

  // Get All Valets
  getAllValets() {
    return this.valets.map(valet => ({
      id: valet.id,
      name: `${valet.firstName} ${valet.lastName}`,
      email: valet.email,
      phone: valet.phone,
      status: valet.status,
      carsParked: valet.carsParked,
      totalEarnings: valet.totalEarnings,
      averageRating: valet.averageRating,
      totalRatings: valet.totalRatings
    }));
  }

  // Update Valet Status
  updateValetStatus(valetId, status) {
    const valet = this.valets.find(v => v.id === valetId);
    if (!valet) return { success: false, error: 'Valet not found' };

    valet.status = status; // 'active', 'inactive', 'on-break', 'end-of-shift'

    return { success: true, message: `Valet status updated to ${status}` };
  }
}

module.exports = ValetParkingSystem;
