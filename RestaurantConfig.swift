import Foundation

struct RestaurantConfig {
    static let shared = RestaurantConfig()
    
    // Load from environment or Info.plist
    var websocketURL: URL {
        if let wsURL = ProcessInfo.processInfo.environment["WS_URL"],
           let url = URL(string: wsURL) {
            return url
        }
        
        // Fallback: check Info.plist or use default
        if let plistPath = Bundle.main.path(forResource: "Info", ofType: "plist"),
           let dict = NSDictionary(contentsOfFile: plistPath),
           let wsURL = dict["WS_URL"] as? String,
           let url = URL(string: wsURL) {
            return url
        }
        
        // Default for development
        let isDev = ProcessInfo.processInfo.environment["ENVIRONMENT"] == "development"
        let scheme = isDev ? "ws" : "wss"
        let host = ProcessInfo.processInfo.environment["API_HOST"] ?? "localhost"
        let port = ProcessInfo.processInfo.environment["WS_PORT"] ?? (isDev ? "4000" : "443")
        
        return URL(string: "\(scheme)://\(host):\(port)")!
    }
    
    var restApiURL: String {
        if let apiURL = ProcessInfo.processInfo.environment["API_URL"] {
            return apiURL
        }
        
        let isDev = ProcessInfo.processInfo.environment["ENVIRONMENT"] == "development"
        let scheme = isDev ? "http" : "https"
        let host = ProcessInfo.processInfo.environment["API_HOST"] ?? "localhost"
        let port = ProcessInfo.processInfo.environment["API_PORT"] ?? (isDev ? "3000" : "443")
        
        return "\(scheme)://\(host):\(port)"
    }
    
    var apiKey: String? {
        return ProcessInfo.processInfo.environment["API_KEY"]
    }
    
    var restaurantId: String? {
        return ProcessInfo.processInfo.environment["RESTAURANT_ID"]
    }
    
    var userRole: UserRole {
        if let role = ProcessInfo.processInfo.environment["USER_ROLE"] {
            return UserRole(rawValue: role) ?? .customer
        }
        return .customer
    }
}

enum UserRole: String, Codable {
    case customer = "customer"
    case waiter = "waiter"
    case manager = "manager"
    case bartender = "bartender"
}

struct AuthToken: Codable {
    let accessToken: String
    let refreshToken: String?
    let expiresIn: Int?
    let tokenType: String = "Bearer"
    
    var isExpired: Bool {
        guard let expiresIn = expiresIn else { return false }
        return Date().timeIntervalSince1970 > Double(expiresIn)
    }
}

struct AuthCredentials {
    let username: String
    let password: String
    let restaurantId: String
}

class AuthManager: NSObject, ObservableObject {
    static let shared = AuthManager()
    
    @Published var isAuthenticated = false
    @Published var currentUser: RestaurantUser?
    @Published var authToken: AuthToken?
    @Published var errorMessage: String?
    
    private let keychainService = KeychainService()
    private let apiURL = RestaurantConfig.shared.restApiURL
    
    private override init() {
        super.init()
        restoreSessionFromKeychain()
    }
    
    func login(username: String, password: String, restaurantId: String) async throws {
        let credentials = AuthCredentials(username: username, password: password, restaurantId: restaurantId)
        let token = try await authenticate(credentials: credentials)
        
        DispatchQueue.main.async {
            self.authToken = token
            self.isAuthenticated = true
        }
        
        try keychainService.saveToken(token)
    }
    
    func loginWithAPIKey(_ apiKey: String, restaurantId: String) async throws {
        let url = URL(string: "\(apiURL)/auth/api-key")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        
        let body = ["restaurant_id": restaurantId]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.unauthorized)
        }
        
        let token = try JSONDecoder().decode(AuthToken.self, from: data)
        
        DispatchQueue.main.async {
            self.authToken = token
            self.isAuthenticated = true
        }
        
        try keychainService.saveToken(token)
    }
    
    private func authenticate(credentials: AuthCredentials) async throws -> AuthToken {
        let url = URL(string: "\(apiURL)/auth/login")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body: [String: Any] = [
            "username": credentials.username,
            "password": credentials.password,
            "restaurant_id": credentials.restaurantId
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.unauthorized)
        }
        
        return try JSONDecoder().decode(AuthToken.self, from: data)
    }
    
    func logout() {
        DispatchQueue.main.async {
            self.isAuthenticated = false
            self.currentUser = nil
            self.authToken = nil
        }
        try? keychainService.deleteToken()
    }
    
    private func restoreSessionFromKeychain() {
        if let token = try? keychainService.getToken() {
            authToken = token
            isAuthenticated = !token.isExpired
        }
    }
}

// MARK: - Keychain Service

class KeychainService {
    private let service = "com.easyflirt.restaurant"
    private let account = "authToken"
    
    func saveToken(_ token: AuthToken) throws {
        let encoder = JSONEncoder()
        let data = try encoder.encode(token)
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data
        ]
        
        SecItemDelete(query as CFDictionary)
        
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw URLError(.cannotDecodeRawData)
        }
    }
    
    func getToken() throws -> AuthToken? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true
        ]
        
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        
        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        
        let decoder = JSONDecoder()
        return try decoder.decode(AuthToken.self, from: data)
    }
    
    func deleteToken() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw URLError(.cannotDecodeRawData)
        }
    }
}

// MARK: - Restaurant User

struct RestaurantUser: Codable {
    let id: String
    let username: String
    let firstName: String?
    let lastName: String?
    let email: String?
    let restaurantId: String
    let role: UserRole
    let assignedTables: [String]?
    let createdAt: String?
    
    var displayName: String {
        if let first = firstName, let last = lastName {
            return "\(first) \(last)"
        }
        return firstName ?? username
    }
}
