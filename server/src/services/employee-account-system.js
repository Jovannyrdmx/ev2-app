// EV2 Clandestinoz - Employee Account Management System with Mexican Support

class EmployeeAccountSystem {
  constructor() {
    this.employees = [];
    this.accounts = [];
    this.earnings = {};
    this.transactions = [];
    this.exchangeRate = 17.50; // Default MXN to USD rate (can be updated)
    this.currency = 'MXN'; // Default currency
  }

  // Update Exchange Rate
  setExchangeRate(rate) {
    this.exchangeRate = rate;
  }

  // Get Exchange Rate
  getExchangeRate() {
    return this.exchangeRate;
  }

  // Set Currency
  setCurrency(currency) {
    if (currency === 'MXN' || currency === 'USD') {
      this.currency = currency;
    }
  }

  // Convert MXN to USD
  convertToUSD(mxnAmount) {
    return mxnAmount / this.exchangeRate;
  }

  // Convert USD to MXN
  convertToMXN(usdAmount) {
    return usdAmount * this.exchangeRate;
  }

  // Format Currency
  formatCurrency(amount, currency = null) {
    const curr = currency || this.currency;
    if (curr === 'MXN') {
      return `$${amount.toLocaleString('es-MX', { minimumFractionDigits: 2 })} MXN`;
    } else {
      return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`;
    }
  }

  // Employee Registration
  registerEmployee(employeeData) {
    // Validate required fields
    if (!employeeData.firstName || !employeeData.lastName || !employeeData.email || !employeeData.phone || !employeeData.role) {
      return { success: false, error: 'All fields required' };
    }

    // Check if email already registered
    if (this.employees.find(e => e.email === employeeData.email)) {
      return { success: false, error: 'Email already registered' };
    }

    const employee = {
      id: `emp_${Date.now()}`,
      firstName: employeeData.firstName,
      lastName: employeeData.lastName,
      email: employeeData.email,
      phone: employeeData.phone,
      role: employeeData.role, // 'hostess', 'dj', 'lighttech', 'bartender', 'waiter', 'dancer'
      profileImage: employeeData.profileImage || null,
      bankAccount: null,
      paymentMethod: null,
      location: employeeData.location || 'Mexico', // Mexico or USA
      status: 'active',
      registeredAt: new Date(),
      lastLogin: null,
      totalEarnings: 0, // In MXN
      preferredCurrency: employeeData.preferredCurrency || 'MXN', // MXN or USD
      accountVerified: false
    };

    this.employees.push(employee);
    this.earnings[employee.id] = {
      tips: 0,
      songs: 0,
      total: 0,
      transactions: []
    };

    return { success: true, employee: employee };
  }

  // Employee Login
  loginEmployee(email, password) {
    const employee = this.employees.find(e => e.email === email);
    
    if (!employee) {
      return { success: false, error: 'Employee not found' };
    }

    if (employee.status !== 'active') {
      return { success: false, error: 'Account is inactive' };
    }

    employee.lastLogin = new Date();

    return {
      success: true,
      employee: {
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        role: employee.role,
        location: employee.location,
        preferredCurrency: employee.preferredCurrency,
        totalEarnings: employee.totalEarnings,
        totalEarningsFormatted: this.formatCurrency(employee.totalEarnings, employee.preferredCurrency),
        profileImage: employee.profileImage
      },
      token: `token_${employee.id}_${Date.now()}`
    };
  }

  // Add Mexican Bank Account
  addMexicanBankAccount(employeeId, bankData) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    employee.bankAccount = {
      type: 'mexican',
      bankName: bankData.bankName,
      accountNumber: bankData.accountNumber.slice(-4), // Only store last 4 digits
      clabe: bankData.clabe, // 18-digit bank account number
      accountHolder: bankData.accountHolder,
      curp: bankData.curp, // Mexican ID number
      rfc: bankData.rfc, // Federal Taxpayer Registry
      addedAt: new Date()
    };

    return { success: true, message: 'Mexican bank account added successfully' };
  }

  // Add USA Bank Account
  addUSABankAccount(employeeId, bankData) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    employee.bankAccount = {
      type: 'usa',
      bankName: bankData.bankName,
      accountNumber: bankData.accountNumber.slice(-4),
      routingNumber: bankData.routingNumber.slice(-4),
      accountHolder: bankData.accountHolder,
      ssn: bankData.ssn ? bankData.ssn.slice(-4) : null, // Last 4 of SSN
      addedAt: new Date()
    };

    return { success: true, message: 'USA bank account added successfully' };
  }

  // Add Payment Method (Stripe, PayPal, etc)
  addPaymentMethod(employeeId, paymentData) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    employee.paymentMethod = {
      type: paymentData.type, // 'stripe', 'paypal', 'bank_transfer', 'cash', 'mercado_pago', 'oxxo'
      identifier: paymentData.identifier,
      currency: paymentData.currency || 'MXN',
      verified: false,
      addedAt: new Date()
    };

    return { success: true, message: 'Payment method added' };
  }

  // Record Tip (in MXN)
  recordTip(toEmployeeId, fromGuestId, amountMXN, staffType, message = '') {
    const employee = this.employees.find(e => e.id === toEmployeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    const transaction = {
      id: `tip_${Date.now()}`,
      type: 'tip',
      from: fromGuestId,
      to: toEmployeeId,
      amountMXN: amountMXN,
      amountUSD: this.convertToUSD(amountMXN),
      staffType: staffType,
      message: message,
      timestamp: new Date(),
      status: 'completed',
      currency: 'MXN'
    };

    this.transactions.push(transaction);
    
    // Update employee earnings (stored in MXN)
    employee.totalEarnings += amountMXN;
    this.earnings[toEmployeeId].tips += amountMXN;
    this.earnings[toEmployeeId].total += amountMXN;
    this.earnings[toEmployeeId].transactions.push(transaction);

    return { success: true, transaction: transaction };
  }

  // Record Song Request Tip (in MXN)
  recordSongRequestTip(toEmployeeId, fromGuestId, amountMXN, songName, artistName, message = '') {
    const employee = this.employees.find(e => e.id === toEmployeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    const transaction = {
      id: `song_${Date.now()}`,
      type: 'song_request',
      from: fromGuestId,
      to: toEmployeeId,
      amountMXN: amountMXN,
      amountUSD: this.convertToUSD(amountMXN),
      songName: songName,
      artistName: artistName,
      message: message,
      timestamp: new Date(),
      status: 'completed',
      currency: 'MXN'
    };

    this.transactions.push(transaction);
    
    // Update employee earnings (stored in MXN)
    employee.totalEarnings += amountMXN;
    this.earnings[toEmployeeId].songs += amountMXN;
    this.earnings[toEmployeeId].total += amountMXN;
    this.earnings[toEmployeeId].transactions.push(transaction);

    return { success: true, transaction: transaction };
  }

  // Get Employee Dashboard with Currency Conversion
  getEmployeeDashboard(employeeId, displayCurrency = null) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    const earnings = this.earnings[employeeId];
    const currency = displayCurrency || employee.preferredCurrency;

    // Calculate totals in selected currency
    const totalMXN = earnings.total;
    const totalUSD = this.convertToUSD(totalMXN);
    const tipsMXN = earnings.tips;
    const tipsUSD = this.convertToUSD(tipsMXN);
    const songsMXN = earnings.songs;
    const songsUSD = this.convertToUSD(songsMXN);

    return {
      success: true,
      employee: {
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        role: employee.role,
        location: employee.location,
        preferredCurrency: employee.preferredCurrency,
        profileImage: employee.profileImage,
        bankAccount: employee.bankAccount ? { 
          type: employee.bankAccount.type,
          bankName: employee.bankAccount.bankName,
          lastFour: employee.bankAccount.accountNumber 
        } : null,
        paymentMethod: employee.paymentMethod ? {
          type: employee.paymentMethod.type,
          currency: employee.paymentMethod.currency,
          verified: employee.paymentMethod.verified
        } : null
      },
      earnings: {
        // In MXN
        totalTipsMXN: tipsMXN,
        totalSongsMXN: songsMXN,
        grandTotalMXN: totalMXN,
        // In USD
        totalTipsUSD: tipsUSD,
        totalSongsUSD: songsUSD,
        grandTotalUSD: totalUSD,
        // Formatted
        totalTipsFormatted: this.formatCurrency(tipsMXN, currency === 'MXN' ? 'MXN' : 'USD'),
        totalSongsFormatted: this.formatCurrency(songsMXN, currency === 'MXN' ? 'MXN' : 'USD'),
        grandTotalFormatted: this.formatCurrency(totalMXN, currency === 'MXN' ? 'MXN' : 'USD'),
      },
      recentTransactions: earnings.transactions.slice(-10).map(t => ({
        ...t,
        amountMXNFormatted: this.formatCurrency(t.amountMXN, 'MXN'),
        amountUSDFormatted: this.formatCurrency(t.amountUSD, 'USD')
      }))
    };
  }

  // Get All Employees by Role
  getEmployeesByRole(role) {
    return this.employees.filter(e => e.role === role && e.status === 'active');
  }

  // Get All Employees
  getAllEmployees() {
    return this.employees.filter(e => e.status === 'active');
  }

  // Get Employee by Email
  getEmployeeByEmail(email) {
    return this.employees.find(e => e.email === email);
  }

  // Update Employee Profile
  updateEmployeeProfile(employeeId, updates) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    if (updates.firstName) employee.firstName = updates.firstName;
    if (updates.lastName) employee.lastName = updates.lastName;
    if (updates.phone) employee.phone = updates.phone;
    if (updates.profileImage) employee.profileImage = updates.profileImage;
    if (updates.preferredCurrency) employee.preferredCurrency = updates.preferredCurrency;
    if (updates.location) employee.location = updates.location;

    return { success: true, employee: employee };
  }

  // Get Earnings Report with Currency Options
  getEarningsReport(employeeId, startDate = null, endDate = null, currency = 'MXN') {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    let transactions = this.earnings[employeeId].transactions;

    // Filter by date range if provided
    if (startDate && endDate) {
      transactions = transactions.filter(t => {
        const tDate = new Date(t.timestamp);
        return tDate >= new Date(startDate) && tDate <= new Date(endDate);
      });
    }

    const tipsMXN = transactions.filter(t => t.type === 'tip').reduce((sum, t) => sum + t.amountMXN, 0);
    const songsMXN = transactions.filter(t => t.type === 'song_request').reduce((sum, t) => sum + t.amountMXN, 0);
    const totalMXN = transactions.reduce((sum, t) => sum + t.amountMXN, 0);

    const tipsUSD = this.convertToUSD(tipsMXN);
    const songsUSD = this.convertToUSD(songsMXN);
    const totalUSD = this.convertToUSD(totalMXN);

    const report = {
      employeeId: employeeId,
      employeeName: `${employee.firstName} ${employee.lastName}`,
      role: employee.role,
      location: employee.location,
      currency: currency,
      totalTransactions: transactions.length,
      // MXN values
      tipsMXN: tipsMXN,
      songsMXN: songsMXN,
      grandTotalMXN: totalMXN,
      // USD values
      tipsUSD: tipsUSD,
      songsUSD: songsUSD,
      grandTotalUSD: totalUSD,
      // Formatted
      tipsFormatted: this.formatCurrency(tipsMXN, currency),
      songsFormatted: this.formatCurrency(songsMXN, currency),
      grandTotalFormatted: this.formatCurrency(totalMXN, currency),
      transactions: transactions.map(t => ({
        ...t,
        amountFormatted: this.formatCurrency(t.amountMXN, currency),
        amountMXNFormatted: this.formatCurrency(t.amountMXN, 'MXN'),
        amountUSDFormatted: this.formatCurrency(t.amountUSD, 'USD')
      }))
    };

    return { success: true, report: report };
  }

  // Withdraw Earnings
  withdrawEarnings(employeeId, amountMXN, currency = 'MXN') {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    if (employee.totalEarnings < amountMXN) {
      return { success: false, error: 'Insufficient earnings' };
    }

    if (!employee.paymentMethod || !employee.paymentMethod.verified) {
      return { success: false, error: 'Payment method not verified' };
    }

    const withdrawal = {
      id: `withdraw_${Date.now()}`,
      employeeId: employeeId,
      amountMXN: amountMXN,
      amountUSD: this.convertToUSD(amountMXN),
      paymentMethod: employee.paymentMethod.type,
      currency: currency,
      status: 'pending',
      requestedAt: new Date(),
      processedAt: null
    };

    employee.totalEarnings -= amountMXN;

    return { success: true, withdrawal: withdrawal };
  }

  // Employee Rankings by Role with Currency
  getTopEarnersByRole(role, limit = 10, currency = 'MXN') {
    const employees = this.employees.filter(e => e.role === role && e.status === 'active');
    
    return employees
      .sort((a, b) => b.totalEarnings - a.totalEarnings)
      .slice(0, limit)
      .map(e => ({
        id: e.id,
        name: `${e.firstName} ${e.lastName}`,
        role: e.role,
        location: e.location,
        totalEarningsMXN: e.totalEarnings,
        totalEarningsUSD: this.convertToUSD(e.totalEarnings),
        totalEarningsFormatted: this.formatCurrency(e.totalEarnings, currency),
        transactions: this.earnings[e.id].transactions.length
      }));
  }

  // Get Top Earners Overall with Currency
  getTopEarners(limit = 20, currency = 'MXN') {
    return this.employees
      .filter(e => e.status === 'active')
      .sort((a, b) => b.totalEarnings - a.totalEarnings)
      .slice(0, limit)
      .map(e => ({
        id: e.id,
        name: `${e.firstName} ${e.lastName}`,
        role: e.role,
        location: e.location,
        totalEarningsMXN: e.totalEarnings,
        totalEarningsUSD: this.convertToUSD(e.totalEarnings),
        totalEarningsFormatted: this.formatCurrency(e.totalEarnings, currency),
        profileImage: e.profileImage,
        transactions: this.earnings[e.id].transactions.length
      }));
  }

  // Verify Account
  verifyEmployeeAccount(employeeId) {
    const employee = this.employees.find(e => e.id === employeeId);
    if (!employee) return { success: false, error: 'Employee not found' };

    employee.accountVerified = true;
    return { success: true, message: 'Account verified' };
  }

  // Get Admin Dashboard with Currency Support
  getAdminDashboard(currency = 'MXN') {
    const totalEmployees = this.employees.length;
    const totalEarningsMXN = this.employees.reduce((sum, e) => sum + e.totalEarnings, 0);
    const totalEarningsUSD = this.convertToUSD(totalEarningsMXN);
    const totalTransactions = this.transactions.length;

    const earningsByRole = {};
    this.employees.forEach(e => {
      if (!earningsByRole[e.role]) {
        earningsByRole[e.role] = { count: 0, earningsMXN: 0 };
      }
      earningsByRole[e.role].count++;
      earningsByRole[e.role].earningsMXN += e.totalEarnings;
    });

    // Add USD conversion to role earnings
    Object.keys(earningsByRole).forEach(role => {
      earningsByRole[role].earningsUSD = this.convertToUSD(earningsByRole[role].earningsMXN);
      earningsByRole[role].earningsFormatted = this.formatCurrency(earningsByRole[role].earningsMXN, currency);
    });

    return {
      totalEmployees: totalEmployees,
      totalEarningsMXN: totalEarningsMXN,
      totalEarningsUSD: totalEarningsUSD,
      totalEarningsFormatted: this.formatCurrency(totalEarningsMXN, currency),
      totalTransactions: totalTransactions,
      earningsByRole: earningsByRole,
      topEarners: this.getTopEarners(5, currency),
      recentTransactions: this.transactions.slice(-20).map(t => ({
        ...t,
        amountFormatted: this.formatCurrency(t.amountMXN, currency),
        amountMXNFormatted: this.formatCurrency(t.amountMXN, 'MXN'),
        amountUSDFormatted: this.formatCurrency(t.amountUSD, 'USD')
      }))
    };
  }
}

module.exports = EmployeeAccountSystem;
