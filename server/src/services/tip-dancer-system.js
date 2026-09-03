// EV2 Clandestinoz - Tipping & Dancer Interaction System

class TipAndDancerSystem {
  constructor() {
    this.tips = [];
    this.drinksForDancers = [];
    this.staff = [];
    this.dancers = [];
    this.transactions = [];
  }

  // Staff Types
  STAFF_TYPES = {
    hostess: {
      id: 'hostess',
      name: 'Hostess',
      icon: '👩‍💼',
      displayName: 'Anfitriona',
      color: '#9D00FF',
      minTip: 50,
      suggestedTips: [50, 100, 200, 500]
    },
    dj: {
      id: 'dj',
      name: 'DJ',
      icon: '🎧',
      displayName: 'DJ',
      color: '#00FF00',
      minTip: 100,
      suggestedTips: [100, 200, 500, 1000]
    },
    lighttech: {
      id: 'lighttech',
      name: 'Light Tech',
      icon: '💡',
      displayName: 'Técnico de Luces',
      color: '#FFFF00',
      minTip: 75,
      suggestedTips: [75, 150, 300, 750]
    },
    bartender: {
      id: 'bartender',
      name: 'Bartender',
      icon: '🍹',
      displayName: 'Cantinero',
      color: '#FF8C00',
      minTip: 50,
      suggestedTips: [50, 100, 200, 500]
    },
    waiter: {
      id: 'waiter',
      name: 'Waiter',
      icon: '👨‍💼',
      displayName: 'Mesero',
      color: '#00BFFF',
      minTip: 50,
      suggestedTips: [50, 100, 200, 500]
    },
    dancer: {
      id: 'dancer',
      name: 'Dancer',
      icon: '💃',
      displayName: 'Ambientadora',
      color: '#FF1493',
      minTip: 100,
      suggestedTips: [100, 200, 500, 1000]
    }
  };

  // Register Staff Member
  registerStaff(staffId, name, type, table = null) {
    const staffMember = {
      id: staffId,
      name: name,
      type: type, // 'waiter' or 'abientadora'
      displayName: this.STAFF_TYPES[type].displayName,
      icon: this.STAFF_TYPES[type].icon,
      assignedTable: table,
      totalTipsReceived: 0,
      totalDrinksReceived: 0,
      rating: 5.0,
      created_at: new Date()
    };

    this.staff.push(staffMember);
    return staffMember;
  }

  // Get Staff by Table
  getStaffByTable(tableId) {
    return this.staff.filter(s => s.assignedTable === tableId);
  }

  // Get All Hostesses
  getAllHostesses() {
    return this.staff.filter(s => s.type === 'hostess');
  }

  // Get All DJs
  getAllDJs() {
    return this.staff.filter(s => s.type === 'dj');
  }

  // Get All Light Techs
  getAllLightTechs() {
    return this.staff.filter(s => s.type === 'lighttech');
  }

  // Get All Bartenders
  getAllBartenders() {
    return this.staff.filter(s => s.type === 'bartender');
  }

  // Get All Waiters
  getAllWaiters() {
    return this.staff.filter(s => s.type === 'waiter');
  }

  // Get All Dancers
  getAllDancers() {
    return this.staff.filter(s => s.type === 'dancer');
  }

  // Send Tip to Staff
  sendTip(fromUserId, toStaffId, amount, staffType, message = '') {
    const staff = this.staff.find(s => s.id === toStaffId);
    if (!staff) return { error: 'Staff not found' };

    // Validate minimum tip
    const minTip = this.STAFF_TYPES[staffType].minTip;
    if (amount < minTip) {
      return { error: `Minimum tip: $${minTip}` };
    }

    const tip = {
      id: `tip_${Date.now()}`,
      fromUserId: fromUserId,
      toStaffId: toStaffId,
      staffName: staff.name,
      staffType: staffType,
      displayName: this.STAFF_TYPES[staffType].displayName,
      amount: amount,
      message: message,
      timestamp: new Date(),
      status: 'completed',
      currency: 'MXN'
    };

    this.tips.push(tip);

    // Update staff total
    staff.totalTipsReceived += amount;

    // Create transaction record
    this.createTransaction(fromUserId, toStaffId, 'tip', amount, staffType);

    return {
      success: true,
      tip: tip,
      message: `Tip of $${amount} sent to ${staff.name}`
    };
  }

  // Send Drink to Staff/Dancer
  sendDrinkToStaff(fromUserId, fromTableId, toStaffId, drinkType, message = '') {
    const staff = this.staff.find(s => s.id === toStaffId);
    if (!staff) return { error: 'Staff not found' };

    const drinkOrder = {
      id: `drink_${Date.now()}`,
      fromUserId: fromUserId,
      fromTableId: fromTableId,
      toStaffId: toStaffId,
      staffName: staff.name,
      staffType: staff.type,
      displayName: this.STAFF_TYPES[staff.type].displayName,
      drinkType: drinkType,
      message: message,
      timestamp: new Date(),
      status: 'pending', // 'pending', 'preparing', 'ready', 'delivered'
      deliveryTime: null,
      receivedAt: null
    };

    this.drinksForDancers.push(drinkOrder);

    // Update staff total
    staff.totalDrinksReceived += 1;

    return {
      success: true,
      drinkOrder: drinkOrder,
      message: `${drinkType} sent to ${staff.name}`
    };
  }

  // Confirm Drink Received
  confirmDrinkReceived(drinkOrderId, staffId) {
    const drink = this.drinksForDancers.find(d => d.id === drinkOrderId);
    if (!drink) return { error: 'Drink order not found' };

    drink.status = 'delivered';
    drink.receivedAt = new Date();

    return {
      success: true,
      drink: drink,
      message: 'Drink received'
    };
  }

  // Get Pending Drinks for Staff
  getPendingDrinksForStaff(staffId) {
    return this.drinksForDancers.filter(d => d.toStaffId === staffId && d.status !== 'delivered');
  }

  // Get Staff Tips History
  getStaffTipsHistory(staffId) {
    return this.tips.filter(t => t.toStaffId === staffId);
  }

  // Get Staff Earnings Summary
  getStaffEarnings(staffId) {
    const tipsReceived = this.tips.filter(t => t.toStaffId === staffId);
    const drinksReceived = this.drinksForDancers.filter(d => d.toStaffId === staffId && d.status === 'delivered');

    return {
      staffId: staffId,
      totalTipsAmount: tipsReceived.reduce((sum, t) => sum + t.amount, 0),
      totalTipsCount: tipsReceived.length,
      totalDrinksReceived: drinksReceived.length,
      averageTipAmount: tipsReceived.length > 0 ? tipsReceived.reduce((sum, t) => sum + t.amount, 0) / tipsReceived.length : 0,
      summary: tipsReceived
    };
  }

  // Quick Tip Presets
  getQuickTips(staffType) {
    return this.STAFF_TYPES[staffType].suggestedTips;
  }

  // Popular Drinks to Send
  getPopularDrinks() {
    return [
      { name: 'Champagne', icon: '🍾', price: 300 },
      { name: 'Tequila Shot', icon: '🥃', price: 100 },
      { name: 'Margarita', icon: '🍹', price: 200 },
      { name: 'Cosmopolitan', icon: '🍸', price: 250 },
      { name: 'Mai Tai', icon: '🍹', price: 220 },
      { name: 'Mojito', icon: '🍃', price: 180 },
      { name: 'Vodka Red Bull', icon: '⚡', price: 150 },
      { name: 'Whiskey Neat', icon: '🥃', price: 200 },
      { name: 'Piña Colada', icon: '🥥', price: 210 },
      { name: 'Sex on the Beach', icon: '🏖️', price: 190 }
    ];
  }

  // Create Transaction Record
  createTransaction(fromUserId, toStaffId, type, amount, staffType) {
    const transaction = {
      id: `txn_${Date.now()}`,
      fromUserId: fromUserId,
      toStaffId: toStaffId,
      type: type, // 'tip' or 'drink'
      amount: amount,
      staffType: staffType,
      timestamp: new Date(),
      status: 'completed'
    };

    this.transactions.push(transaction);
    return transaction;
  }

  // Get Leaderboard (Top Tipped Staff)
  getTopTippedStaff(limit = 10) {
    const staffEarnings = this.staff.map(s => {
      const tips = this.tips.filter(t => t.toStaffId === s.id);
      return {
        staff: s,
        totalTips: tips.reduce((sum, t) => sum + t.amount, 0),
        tipCount: tips.length,
        averageTip: tips.length > 0 ? tips.reduce((sum, t) => sum + t.amount, 0) / tips.length : 0
      };
    });

    return staffEarnings
      .sort((a, b) => b.totalTips - a.totalTips)
      .slice(0, limit);
  }

  // Get Leaderboard (Most Popular Dancers)
  getTopDancers(limit = 10) {
    const dancers = this.staff.filter(s => s.type === 'dancer');
    
    const dancerStats = dancers.map(d => {
      const drinks = this.drinksForDancers.filter(dr => dr.toStaffId === d.id && dr.status === 'delivered');
      const tips = this.tips.filter(t => t.toStaffId === d.id);
      return {
        dancer: d,
        drinksReceived: drinks.length,
        tipsReceived: tips.reduce((sum, t) => sum + t.amount, 0),
        totalEarnings: tips.reduce((sum, t) => sum + t.amount, 0),
        popularity: drinks.length + (tips.length * 2) // Custom scoring
      };
    });

    return dancerStats
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, limit);
  }

  // Tip Notification (for real-time updates)
  formatTipNotification(tip) {
    return {
      icon: this.STAFF_TYPES[tip.staffType].icon,
      title: `Tip from Guest`,
      message: `$${tip.amount} tip for ${tip.staffName}`,
      staffType: tip.staffType,
      amount: tip.amount,
      timestamp: tip.timestamp
    };
  }

  // Drink Notification (for real-time updates)
  formatDrinkNotification(drink) {
    return {
      icon: '🍹',
      title: `Drink Order`,
      message: `${drink.drinkType} from Table ${drink.fromTableId}`,
      staffType: drink.staffType,
      timestamp: drink.timestamp,
      message_note: drink.message || 'No message'
    };
  }
}

module.exports = TipAndDancerSystem;
