// SoftRestaurant 11 integration — PLACEHOLDER.
//
// The legacy client that used to live here assumed a REST API at /api/tables,
// /api/menu/drinks and /api/orders with an X-API-Key header. Step 0.9 established that
// no such API exists for third parties: the club runs SR 11.0.98 on a LAN SQL Server and
// the supported paths are National Soft's integration programme or a local agent
// (decision D16). See docs/POS_REAL.md.
//
// Nothing here is called by the API today. The real implementation lands in phase 4,
// against the mechanism National Soft confirms, and is exercised by the pos-mock service.
'use strict';

const { ApiError } = require('../../middleware/errors');

const NOT_READY = 'SoftRestaurant integration is not implemented yet (phase 4, see docs/POS_REAL.md)';

class SoftRestaurant11Client {
  constructor(config = {}) {
    this.config = config;
  }

  // eslint-disable-next-line class-methods-use-this
  async getMenu() { throw ApiError.notImplemented(NOT_READY); }

  // eslint-disable-next-line class-methods-use-this
  async getInventory() { throw ApiError.notImplemented(NOT_READY); }

  // eslint-disable-next-line class-methods-use-this
  async getTables() { throw ApiError.notImplemented(NOT_READY); }

  // eslint-disable-next-line class-methods-use-this
  async createOrder() { throw ApiError.notImplemented(NOT_READY); }

  // eslint-disable-next-line class-methods-use-this
  async getOrderStatus() { throw ApiError.notImplemented(NOT_READY); }
}

module.exports = { SoftRestaurant11Client, NOT_READY };
