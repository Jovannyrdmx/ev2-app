// EV2 Clandestinoz - Complete Flirt System

class FlirtSystem {
  constructor() {
    this.flirts = [];
    this.reactions = [];
    this.flirtChains = {};
  }

  // Flirt Types
  FLIRT_TYPES = {
    drink: { icon: "🍷", name: "Send Drink", color: "#FF1493" },
    bottle: { icon: "🍾", name: "Bottle Service", color: "#FFD700" },
    emoji_wave: { icon: "👋", name: "Wave", color: "#00BFFF" },
    emoji_wink: { icon: "😉", name: "Wink", color: "#FF1493" },
    emoji_kiss: { icon: "😘", name: "Kiss", color: "#FF1493" },
    emoji_fire: { icon: "🔥", name: "Fire", color: "#FFD700" },
    emoji_heart: { icon: "❤️", name: "Heart", color: "#FF1493" },
    dance_invite: { icon: "💃", name: "Dance Invite", color: "#9D00FF" },
    photo_request: { icon: "📸", name: "Photo Request", color: "#00BFFF" },
    compliment: { icon: "⭐", name: "Compliment", color: "#FFD700" }
  };

  REACTION_EMOJIS = {
    like: { emoji: "❤️", label: "Like" },
    love: { emoji: "💕", label: "Love" },
    haha: { emoji: "😂", label: "Haha" },
    wow: { emoji: "😮", label: "Wow" },
    sad: { emoji: "😢", label: "Sad" },
    angry: { emoji: "😠", label: "Angry" },
    sexy: { emoji: "🔥", label: "Sexy" },
    interested: { emoji: "👀", label: "Interested" },
    kiss: { emoji: "😘", label: "Kiss" },
    wave: { emoji: "👋", label: "Wave" }
  };

  // Send a flirt
  sendFlirt(fromUserId, toUserId, flirtType, message = "", tableId = null) {
    const flirt = {
      id: `flirt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      from: fromUserId,
      to: toUserId,
      type: flirtType,
      message: message,
      tableId: tableId,
      timestamp: new Date(),
      status: "sent",
      reactions: [],
      viewed: false,
      viewedAt: null
    };

    this.flirts.push(flirt);

    // Create flirt chain if doesn't exist
    const chainKey = [fromUserId, toUserId].sort().join("_");
    if (!this.flirtChains[chainKey]) {
      this.flirtChains[chainKey] = [];
    }
    this.flirtChains[chainKey].push(flirt.id);

    return flirt;
  }

  // Add reaction to flirt
  addReaction(flirtId, userId, reactionType) {
    const flirt = this.flirts.find(f => f.id === flirtId);
    if (!flirt) return null;

    const reaction = {
      id: `reaction_${Date.now()}`,
      userId: userId,
      type: reactionType,
      emoji: this.REACTION_EMOJIS[reactionType]?.emoji || "👍",
      timestamp: new Date()
    };

    flirt.reactions.push(reaction);
    return flirt;
  }

  // Mark flirt as viewed
  viewFlirt(flirtId) {
    const flirt = this.flirts.find(f => f.id === flirtId);
    if (flirt) {
      flirt.viewed = true;
      flirt.viewedAt = new Date();
      return flirt;
    }
    return null;
  }

  // Get flirts received by user
  getReceivedFlirts(userId, limit = 50) {
    return this.flirts
      .filter(f => f.to === userId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  // Get flirts sent by user
  getSentFlirts(userId, limit = 50) {
    return this.flirts
      .filter(f => f.from === userId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  // Get unviewed flirts
  getUnviewedFlirts(userId) {
    return this.flirts.filter(f => f.to === userId && !f.viewed);
  }

  // Get flirt chain between two users
  getFlirtChain(userId1, userId2) {
    const chainKey = [userId1, userId2].sort().join("_");
    if (!this.flirtChains[chainKey]) return [];

    return this.flirtChains[chainKey]
      .map(flirtId => this.flirts.find(f => f.id === flirtId))
      .filter(f => f !== undefined)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  // Get flirts by table
  getFlirtsByTable(tableId) {
    return this.flirts.filter(f => f.tableId === tableId);
  }

  // Get flirt statistics
  getFlirtStats(userId) {
    const sent = this.flirts.filter(f => f.from === userId);
    const received = this.flirts.filter(f => f.to === userId);
    const unviewed = received.filter(f => !f.viewed);

    return {
      sentCount: sent.length,
      receivedCount: received.length,
      unviewedCount: unviewed.length,
      favoriteType: this.getMostUsedFlirtType(sent),
      connections: this.getConnectionsForUser(userId)
    };
  }

  getMostUsedFlirtType(flirts) {
    const types = {};
    flirts.forEach(f => {
      types[f.type] = (types[f.type] || 0) + 1;
    });
    return Object.keys(types).reduce((a, b) => types[a] > types[b] ? a : b, null);
  }

  getConnectionsForUser(userId) {
    const connections = new Set();
    this.flirts.forEach(f => {
      if (f.from === userId) connections.add(f.to);
      if (f.to === userId) connections.add(f.from);
    });
    return Array.from(connections);
  }

  // Send drink via flirt
  sendDrinkFlirt(fromUserId, toUserId, drinkType, tableId, price = 250) {
    return this.sendFlirt(
      fromUserId,
      toUserId,
      "drink",
      `Sent you a ${drinkType}! 🍹`,
      tableId
    );
  }

  // Send bottle service
  sendBottleFlirt(fromUserId, toUserId, bottleType, tableId, price = 1200) {
    return this.sendFlirt(
      fromUserId,
      toUserId,
      "bottle",
      `Bottle of ${bottleType} incoming! 🍾`,
      tableId
    );
  }

  // Suggest meeting at table
  suggestMeeting(fromUserId, toUserId, tableId, message = "Join me at my table?") {
    return this.sendFlirt(
      fromUserId,
      toUserId,
      "dance_invite",
      message,
      tableId
    );
  }

  // Get trending flirts (most popular in last hour)
  getTrendingFlirts(hourLimit = 1) {
    const oneHourAgo = new Date(Date.now() - hourLimit * 60 * 60 * 1000);
    
    const popular = this.flirts
      .filter(f => f.timestamp > oneHourAgo)
      .map(f => ({
        ...f,
        popularity: f.reactions.length
      }))
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 10);

    return popular;
  }

  // Get conversation preview
  getConversationPreview(userId1, userId2, limit = 5) {
    const chain = this.getFlirtChain(userId1, userId2);
    return chain.slice(-limit).map(f => ({
      from: f.from,
      type: f.type,
      message: f.message,
      timestamp: f.timestamp,
      reactions: f.reactions.length
    }));
  }

  // Clean old flirts (keep last 1000)
  cleanOldFlirts() {
    if (this.flirts.length > 1000) {
      this.flirts = this.flirts
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 1000);
    }
  }

  // Export flirt data
  exportFlirtData(userId) {
    const sent = this.getSentFlirts(userId);
    const received = this.getReceivedFlirts(userId);
    
    return {
      userId: userId,
      sentCount: sent.length,
      receivedCount: received.length,
      connections: this.getConnectionsForUser(userId),
      stats: this.getFlirtStats(userId),
      recentFlirts: {
        sent: sent.slice(0, 10),
        received: received.slice(0, 10)
      }
    };
  }
}

module.exports = FlirtSystem;
