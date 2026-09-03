import Foundation

struct TableAssignment: Codable, Identifiable {
    let id: String
    let waiterId: String
    let tableId: String
    let tableName: String
    let status: TableStatus
    let assignedAt: String
}

enum TableStatus: String, Codable {
    case assigned = "assigned"
    case occupied = "occupied"
    case cleaning = "cleaning"
    case available = "available"
}

struct DrinkOrder: Codable, Identifiable {
    let id: String
    let restaurantId: String
    let senderId: String
    let senderName: String
    let recipientId: String
    let recipientName: String
    let tableId: String
    let tableName: String
    let drink: DrinkItem
    let status: DrinkOrderStatus
    let message: String?
    let createdAt: String
    let deliveredAt: String?
}

struct DrinkItem: Codable {
    let name: String
    let price: Double
    let preparationTime: Int? // seconds
}

enum DrinkOrderStatus: String, Codable {
    case pending = "pending"
    case confirmed = "confirmed"
    case preparing = "preparing"
    case ready = "ready"
    case delivered = "delivered"
    case cancelled = "cancelled"
}

struct WaiterNotification: Codable, Identifiable {
    let id: String
    let waiterId: String
    let type: NotificationType
    let title: String
    let message: String
    let relatedOrderId: String?
    let priority: NotificationPriority
    let read: Bool
    let createdAt: String
}

enum NotificationType: String, Codable {
    case newOrder = "new_order"
    case orderReady = "order_ready"
    case drinkReady = "drink_ready"
    case tableNeedsService = "table_needs_service"
    case customerRequest = "customer_request"
}

enum NotificationPriority: String, Codable {
    case low = "low"
    case normal = "normal"
    case high = "high"
    case urgent = "urgent"
}

class WaiterService {
    static let shared = WaiterService()
    
    private let session: URLSession
    private let baseURL = RestaurantConfig.shared.restApiURL
    private let authManager = AuthManager.shared
    
    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }
    
    // MARK: - Table Assignments
    
    func fetchAssignedTables(restaurantId: String, waiterId: String) async throws -> [TableAssignment] {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/waiters/\(waiterId)/tables")!
        
        let (data, response) = try await authorizedRequest(url: url, method: "GET")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode([TableAssignment].self, from: data)
    }
    
    func updateTableStatus(restaurantId: String, tableId: String, status: TableStatus) async throws -> TableAssignment {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/tables/\(tableId)/status")!
        
        let body = ["status": status.rawValue]
        let (data, response) = try await authorizedRequest(url: url, method: "PATCH", body: body)
        
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode(TableAssignment.self, from: data)
    }
    
    // MARK: - Drink Orders
    
    func fetchPendingDrinkOrders(restaurantId: String, waiterId: String) async throws -> [DrinkOrder] {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/waiters/\(waiterId)/drinks?status=ready")!
        
        let (data, response) = try await authorizedRequest(url: url, method: "GET")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode([DrinkOrder].self, from: data)
    }
    
    func confirmDrinkDelivery(restaurantId: String, drinkOrderId: String) async throws -> DrinkOrder {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/drinks/\(drinkOrderId)/deliver")!
        
        let (data, response) = try await authorizedRequest(url: url, method: "POST")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode(DrinkOrder.self, from: data)
    }
    
    // MARK: - Notifications
    
    func fetchNotifications(restaurantId: String, waiterId: String, unreadOnly: Bool = false) async throws -> [WaiterNotification] {
        var urlString = "\(baseURL)/restaurants/\(restaurantId)/waiters/\(waiterId)/notifications"
        if unreadOnly {
            urlString += "?unread=true"
        }
        
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        
        let (data, response) = try await authorizedRequest(url: url, method: "GET")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode([WaiterNotification].self, from: data)
    }
    
    func markNotificationAsRead(restaurantId: String, notificationId: String) async throws {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/notifications/\(notificationId)/read")!
        
        let _ = try await authorizedRequest(url: url, method: "POST")
    }
    
    func checkIn(restaurantId: String, waiterId: String) async throws {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/waiters/\(waiterId)/checkin")!
        
        let _ = try await authorizedRequest(url: url, method: "POST")
    }
    
    func checkOut(restaurantId: String, waiterId: String) async throws {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/waiters/\(waiterId)/checkout")!
        
        let _ = try await authorizedRequest(url: url, method: "POST")
    }
    
    // MARK: - Helper Methods
    
    private func authorizedRequest(url: URL, method: String, body: [String: Any]? = nil) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if let token = authManager.authToken {
            request.setValue("Bearer \(token.accessToken)", forHTTPHeaderField: "Authorization")
        }
        
        if let body = body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        
        return try await session.data(for: request)
    }
}
