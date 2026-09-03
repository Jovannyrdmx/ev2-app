import Foundation

struct MenuItem: Codable, Identifiable {
    let id: String
    let name: String
    let category: String
    let price: Double
    let description: String?
    let available: Bool
    let image: String?
}

struct Inventory: Codable {
    let itemId: String
    let quantity: Int
    let unit: String
    let lowStockThreshold: Int
    let lastUpdated: String
}

struct Order: Codable, Identifiable {
    let id: String
    let restaurantId: String
    let tableId: String?
    let customerId: String
    let items: [OrderItem]
    let status: OrderStatus
    let total: Double
    let notes: String?
    let createdAt: String
    let updatedAt: String
    let deliveredAt: String?
}

struct OrderItem: Codable, Identifiable {
    let id: String
    let menuItemId: String
    let menuItemName: String
    let quantity: Int
    let price: Double
    let specialInstructions: String?
    let status: OrderItemStatus
}

enum OrderStatus: String, Codable {
    case pending = "pending"
    case confirmed = "confirmed"
    case preparing = "preparing"
    case ready = "ready"
    case delivered = "delivered"
    case cancelled = "cancelled"
}

enum OrderItemStatus: String, Codable {
    case pending = "pending"
    case confirmed = "confirmed"
    case preparing = "preparing"
    case ready = "ready"
    case delivered = "delivered"
    case cancelled = "cancelled"
}

class RestaurantService {
    static let shared = RestaurantService()
    
    private let session: URLSession
    private let baseURL = RestaurantConfig.shared.restApiURL
    private let authManager = AuthManager.shared
    
    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }
    
    // MARK: - Menu & Inventory
    
    func fetchMenuItems(restaurantId: String, category: String? = nil) async throws -> [MenuItem] {
        var urlString = "\(baseURL)/restaurants/\(restaurantId)/menu"
        if let category = category {
            urlString += "?category=\(category.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")"
        }
        
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        
        let (data, response) = try await authorizedRequest(url: url, method: "GET")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode([MenuItem].self, from: data)
    }
    
    func fetchInventory(restaurantId: String) async throws -> [Inventory] {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/inventory")!
        
        let (data, response) = try await authorizedRequest(url: url, method: "GET")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode([Inventory].self, from: data)
    }
    
    func updateInventory(restaurantId: String, itemId: String, quantity: Int) async throws {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/inventory/\(itemId)")!
        
        let body = ["quantity": quantity]
        let _ = try await authorizedRequest(url: url, method: "PATCH", body: body)
    }
    
    // MARK: - Orders
    
    func createOrder(restaurantId: String, order: Order) async throws -> Order {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/orders")!
        
        var orderDict = try encodeToDict(order)
        orderDict["restaurant_id"] = restaurantId
        
        let (data, response) = try await authorizedRequest(url: url, method: "POST", body: orderDict)
        guard (response as? HTTPURLResponse)?.statusCode == 201 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode(Order.self, from: data)
    }
    
    func updateOrderStatus(restaurantId: String, orderId: String, status: OrderStatus) async throws -> Order {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/orders/\(orderId)")!
        
        let body = ["status": status.rawValue]
        let (data, response) = try await authorizedRequest(url: url, method: "PATCH", body: body)
        
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode(Order.self, from: data)
    }
    
    func fetchOrders(restaurantId: String, tableId: String? = nil, status: OrderStatus? = nil) async throws -> [Order] {
        var urlString = "\(baseURL)/restaurants/\(restaurantId)/orders"
        var params: [String] = []
        
        if let tableId = tableId {
            params.append("table_id=\(tableId)")
        }
        if let status = status {
            params.append("status=\(status.rawValue)")
        }
        
        if !params.isEmpty {
            urlString += "?" + params.joined(separator: "&")
        }
        
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        
        let (data, response) = try await authorizedRequest(url: url, method: "GET")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode([Order].self, from: data)
    }
    
    func confirmOrderItem(restaurantId: String, orderId: String, itemId: String) async throws -> OrderItem {
        let url = URL(string: "\(baseURL)/restaurants/\(restaurantId)/orders/\(orderId)/items/\(itemId)/confirm")!
        
        let (data, response) = try await authorizedRequest(url: url, method: "POST")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode(OrderItem.self, from: data)
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
    
    private func encodeToDict<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotDecodeRawData)
        }
        return dict
    }
}
