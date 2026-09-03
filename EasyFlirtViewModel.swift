import Foundation
import Combine

@MainActor
class EasyFlirtViewModel: ObservableObject {
    @Published var currentUser: AppUser?
    @Published var selectedTableId: String?
    @Published var tables: [String: WebSocketManager.TableState] = [:]
    @Published var activity: [WebSocketManager.ActivityItem] = []
    @Published var presence: [WebSocketManager.PresenceUser] = []
    @Published var connectionStatus: WebSocketManager.ConnectionStatus = .disconnected
    @Published var errorMessage: String?
    
    private let networkService = NetworkService.shared
    private let webSocket = WebSocketManager.shared
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        setupWebSocketHandlers()
        
        // Observe connection status changes
        webSocket.onConnectionStatusChanged = { [weak self] status in
            DispatchQueue.main.async {
                self?.connectionStatus = status
            }
        }
    }
    
    // MARK: - Setup
    
    private func setupWebSocketHandlers() {
        webSocket.onStateUpdate = { [weak self] state in
            DispatchQueue.main.async {
                self?.tables = state.tables
                self?.activity = state.activity
            }
        }
        
        webSocket.onActivityUpdate = { [weak self] item in
            DispatchQueue.main.async {
                // Only show activity directed at current user (or sent by them)
                if item.to == self?.currentUser?.id || item.from == self?.currentUser?.id {
                    self?.activity.insert(item, at: 0)
                }
            }
        }
        
        webSocket.onPresenceUpdate = { [weak self] presence in
            DispatchQueue.main.async {
                self?.presence = presence
            }
        }
    }
    
    // MARK: - Authentication
    
    func initializeUser() async {
        do {
            let user = try await networkService.createAnonymousUser()
            self.currentUser = user
            
            // Connect WebSocket after user creation
            networkService.webSocket.connect()
            
            // Send identify after connection
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.networkService.webSocket.identify(
                    userId: user.id ?? "",
                    userName: "User \(String(user.id?.prefix(4) ?? ""))",
                    seat: nil
                )
            }
        } catch {
            self.errorMessage = "Failed to initialize user: \(error.localizedDescription)"
            print("Error initializing user: \(error)")
        }
    }
    
    // MARK: - Seat Selection
    
    func selectTable(_ tableId: String) {
        selectedTableId = tableId
        networkService.webSocket.takeSeat(tableId: tableId)
    }
    
    // MARK: - Interactions
    
    func sendDrink(toUserId: String, toUserName: String, drinkName: String, price: Double) {
        let tableName = selectedTableId.flatMap { tables[$0]?.name } ?? "Unknown"
        networkService.webSocket.sendDrink(
            toUserId: toUserId,
            toUserName: toUserName,
            drinkName: drinkName,
            price: price,
            tableName: tableName
        )
    }
    
    func sendFlirt(toUserId: String, toUserName: String, emoji: String, message: String) {
        networkService.webSocket.sendFlirt(
            toUserId: toUserId,
            toUserName: toUserName,
            emoji: emoji,
            message: message
        )
    }
    
    // MARK: - Network Management
    
    func connectWebSocket() {
        networkService.webSocket.connect()
    }
    
    func disconnectWebSocket() {
        networkService.webSocket.disconnect()
    }
    
    deinit {
        disconnectWebSocket()
    }
}
