// EV2 Clandestinoz - Universal POS Integration System

class POSIntegrationSystem {
  constructor() {
    this.integrations = [];
    this.supportedPOS = [
      'toast',
      'square',
      'clover',
      'lightspeed',
      'shopify',
      'wix',
      'custom'
    ];
    this.apiKeys = {};
    this.webhooks = [];
  }

  // Register POS Integration
  registerPOSIntegration(posType, credentials) {
    if (!this.supportedPOS.includes(posType.toLowerCase())) {
      return { 
        success: false, 
        error: `POS type not supported. Supported: ${this.supportedPOS.join(', ')}` 
      };
    }

    const integration = {
      id: `pos_${Date.now()}`,
      posType: posType.toLowerCase(),
      credentials: {
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        merchantId: credentials.merchantId || null,
        locationId: credentials.locationId || null,
        webhookUrl: credentials.webhookUrl || null,
        environment: credentials.environment || 'production'
      },
      status: 'active',
      createdAt: new Date(),
      lastSync: null,
      syncStatus: 'pending'
    };

    this.integrations.push(integration);
    this.apiKeys[integration.id] = integration.credentials;

    return { success: true, integration: integration };
  }

  // Get Supported POS Systems
  getSupportedPOSSystems() {
    return {
      supported: [
        {
          name: 'Toast',
          code: 'toast',
          features: ['Orders', 'Payments', 'Staff', 'Inventory'],
          documentation: 'https://docs.toast.com/api'
        },
        {
          name: 'Square',
          code: 'square',
          features: ['Payments', 'Inventory', 'Orders', 'Customers'],
          documentation: 'https://developer.squareup.com'
        },
        {
          name: 'Clover',
          code: 'clover',
          features: ['Payments', 'Orders', 'Inventory', 'Staff'],
          documentation: 'https://docs.clover.com/clover-platform/docs'
        },
        {
          name: 'Lightspeed',
          code: 'lightspeed',
          features: ['Orders', 'Inventory', 'Payments', 'Customers'],
          documentation: 'https://developer.lightspeedhq.com'
        },
        {
          name: 'Shopify',
          code: 'shopify',
          features: ['Orders', 'Payments', 'Inventory', 'Customers'],
          documentation: 'https://shopify.dev/api'
        },
        {
          name: 'Wix',
          code: 'wix',
          features: ['Bookings', 'Payments', 'Contacts', 'Orders'],
          documentation: 'https://www.wix.com/en/developer'
        },
        {
          name: 'Custom API',
          code: 'custom',
          features: ['Custom Integration', 'Webhooks', 'REST API'],
          documentation: 'Custom Implementation'
        }
      ]
    };
  }

  // Sync Transactions with POS
  syncTransactionsToPOS(integrationId, transactions) {
    const integration = this.integrations.find(i => i.id === integrationId);
    if (!integration) return { success: false, error: 'Integration not found' };

    const syncData = {
      integrationId: integrationId,
      posType: integration.posType,
      transactions: transactions.map(t => ({
        id: t.id,
        type: t.type, // 'tip', 'song_request', 'drink'
        amount: t.amountMXN,
        currency: 'MXN',
        staff: t.toStaffId,
        timestamp: t.timestamp,
        description: this.generateTransactionDescription(t)
      })),
      syncTime: new Date(),
      status: 'pending'
    };

    const syncResult = {
      success: true,
      syncId: `sync_${Date.now()}`,
      ...syncData
    };

    integration.lastSync = new Date();
    integration.syncStatus = 'completed';

    return syncResult;
  }

  // Generate Transaction Description
  generateTransactionDescription(transaction) {
    if (transaction.type === 'tip') {
      return `Staff Tip: ${transaction.staffName} - ${transaction.staffType}`;
    } else if (transaction.type === 'song_request') {
      return `DJ Song Request: ${transaction.songName} by ${transaction.artistName}`;
    } else if (transaction.type === 'drink') {
      return `Drink Order: ${transaction.drinkType}`;
    }
    return 'EV2 Transaction';
  }

  // Setup Webhook
  setupWebhook(integrationId, webhookUrl) {
    const integration = this.integrations.find(i => i.id === integrationId);
    if (!integration) return { success: false, error: 'Integration not found' };

    const webhook = {
      id: `webhook_${Date.now()}`,
      integrationId: integrationId,
      url: webhookUrl,
      events: [
        'transaction.created',
        'transaction.updated',
        'staff.earnings.updated',
        'withdrawal.processed'
      ],
      active: true,
      createdAt: new Date()
    };

    this.webhooks.push(webhook);
    integration.credentials.webhookUrl = webhookUrl;

    return { success: true, webhook: webhook };
  }

  // Test POS Connection
  testPOSConnection(integrationId) {
    const integration = this.integrations.find(i => i.id === integrationId);
    if (!integration) return { success: false, error: 'Integration not found' };

    // Simulate API call to POS system
    const testResult = {
      success: true,
      posType: integration.posType,
      connected: true,
      credentials: {
        apiKey: `${integration.credentials.apiKey.slice(0, 4)}...${integration.credentials.apiKey.slice(-4)}`,
        merchantId: integration.credentials.merchantId,
        locationId: integration.credentials.locationId
      },
      testTime: new Date(),
      responseTime: '245ms'
    };

    return testResult;
  }

  // Get Integration Status
  getIntegrationStatus(integrationId) {
    const integration = this.integrations.find(i => i.id === integrationId);
    if (!integration) return { success: false, error: 'Integration not found' };

    return {
      success: true,
      integrationId: integration.id,
      posType: integration.posType,
      status: integration.status,
      lastSync: integration.lastSync,
      syncStatus: integration.syncStatus,
      webhooks: this.webhooks.filter(w => w.integrationId === integrationId).length,
      createdAt: integration.createdAt
    };
  }

  // Get All Integrations
  getAllIntegrations() {
    return this.integrations.map(i => ({
      id: i.id,
      posType: i.posType,
      status: i.status,
      lastSync: i.lastSync,
      syncStatus: i.syncStatus,
      createdAt: i.createdAt,
      webhookCount: this.webhooks.filter(w => w.integrationId === i.id).length
    }));
  }

  // Update Integration
  updateIntegration(integrationId, updates) {
    const integration = this.integrations.find(i => i.id === integrationId);
    if (!integration) return { success: false, error: 'Integration not found' };

    if (updates.credentials) {
      integration.credentials = { ...integration.credentials, ...updates.credentials };
    }
    if (updates.status) {
      integration.status = updates.status;
    }
    if (updates.environment) {
      integration.credentials.environment = updates.environment;
    }

    return { success: true, integration: integration };
  }

  // Delete Integration
  deleteIntegration(integrationId) {
    const index = this.integrations.findIndex(i => i.id === integrationId);
    if (index === -1) return { success: false, error: 'Integration not found' };

    const deleted = this.integrations.splice(index, 1);

    // Delete associated webhooks
    this.webhooks = this.webhooks.filter(w => w.integrationId !== integrationId);

    return { success: true, deleted: deleted[0] };
  }

  // Get API Documentation
  getAPIDocumentation(posType) {
    const posSystem = this.supportedPOS.find(p => p === posType.toLowerCase());
    if (!posSystem) return { success: false, error: 'POS type not found' };

    const docs = {
      posType: posType,
      baseUrl: this.getBaseURL(posType),
      authentication: this.getAuthenticationMethod(posType),
      endpoints: this.getEndpoints(posType),
      webhookEvents: this.getWebhookEvents(posType)
    };

    return { success: true, documentation: docs };
  }

  // Get Base URL for POS
  getBaseURL(posType) {
    const urls = {
      toast: 'https://api.toasttab.com',
      square: 'https://connect.squareup.com',
      clover: 'https://api.clover.com',
      lightspeed: 'https://api.merchantos.com',
      shopify: 'https://your-store.myshopify.com/admin/api',
      wix: 'https://www.wixapis.com',
      custom: 'https://your-custom-api.com'
    };
    return urls[posType.toLowerCase()] || '';
  }

  // Get Authentication Method
  getAuthenticationMethod(posType) {
    const auth = {
      toast: 'OAuth 2.0 with API Key',
      square: 'OAuth 2.0 with Personal Access Token',
      clover: 'API Key Header Authentication',
      lightspeed: 'OAuth 2.0',
      shopify: 'Custom App with API Credentials',
      wix: 'OAuth 2.0',
      custom: 'Custom Implementation'
    };
    return auth[posType.toLowerCase()] || '';
  }

  // Get Endpoints
  getEndpoints(posType) {
    return {
      posType: posType,
      transactions: `/transactions`,
      staff: `/staff/members`,
      earnings: `/earnings`,
      payments: `/payments`,
      inventory: `/inventory`,
      webhook: `/webhooks`
    };
  }

  // Get Webhook Events
  getWebhookEvents(posType) {
    return [
      'transaction.created',
      'transaction.updated',
      'staff.earnings.updated',
      'withdrawal.processed',
      'payment.completed',
      'payment.failed',
      'sync.completed'
    ];
  }

  // Get Integration Guide
  getIntegrationGuide(businessType = 'nightclub') {
    return {
      businessType: businessType,
      setupSteps: [
        'Choose your POS system',
        'Register POS integration',
        'Enter API credentials',
        'Test connection',
        'Setup webhooks',
        'Sync transactions',
        'Monitor integration'
      ],
      requirements: {
        apiKey: 'Required for authentication',
        apiSecret: 'Required for secure requests',
        webhookUrl: 'Optional but recommended for real-time sync',
        merchantId: 'Required for some POS systems',
        locationId: 'Required for multi-location businesses'
      },
      benefits: [
        'Automatic transaction sync',
        'Real-time earnings tracking',
        'Unified staff management',
        'Centralized payment processing',
        'Automated reporting',
        'Multi-currency support'
      ]
    };
  }

  // Generate Integration Report
  generateIntegrationReport(integrationId) {
    const integration = this.integrations.find(i => i.id === integrationId);
    if (!integration) return { success: false, error: 'Integration not found' };

    return {
      integrationId: integration.id,
      posType: integration.posType,
      status: integration.status,
      createdAt: integration.createdAt,
      lastSync: integration.lastSync,
      syncStatus: integration.syncStatus,
      environment: integration.credentials.environment,
      webhookCount: this.webhooks.filter(w => w.integrationId === integrationId).length,
      features: [
        'Transaction Sync',
        'Staff Earnings',
        'Payment Processing',
        'Webhook Support',
        'Real-time Updates',
        'Multi-currency'
      ]
    };
  }
}

module.exports = POSIntegrationSystem;
