import Foundation
import UIKit

class WebSocketManager: NSObject, URLSessionWebSocketDelegate {
    static let shared = WebSocketManager()
    
    private var webSocket: URLSessionWebSocket?
    private let wsURL: URL
    private var reconnectTimer: Timer?
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 5
    private let reconnectInterval: TimeInterval = 3.0
    
    // Publishers for real-time updates
    var onConnectionStatusChanged: ((ConnectionStatus) -> Void)?
    var onStateUpdate: ((SharedState) -> Void)?
    var onActivityUpdate: ((ActivityItem) -> Void)?
    var onPresenceUpdate: (([PresenceUser]) -> Void)?
    
    private(set) var connectionStatus: ConnectionStatus = .disconnected {
        didSet {
            DispatchQueue.main.async {
                self.onConnectionStatusChanged?(self.connectionStatus)
            }
        }
    }
    
    enum ConnectionStatus {
        case connecting
        case connected
        case disconnected
        case reconnecting
    }
    
    struct SharedState: Codable {
        let tables: [String: TableState]
        let activity: [ActivityItem]
    }
    
    struct TableState: Codable {
        let id: String
        let name: String
        let section: String
        let capacity: Int
        let occupants: [Occupant]
    }
    
    struct Occupant: Codable {
        let id: String
        let name: String
    }
    
    struct ActivityItem: Codable {
        let id: Int64
        let type: String // "drink" or "flirt"
        let from: String
        let fromName: String
        let to: String
        let toName: String
        let item: String
        let message: String?
        let price: Double?
        let table: String?
        let timestamp: String
    }
    
    struct PresenceUser: Codable {
        let id: String
        let name: String
        let seat: String?
    }
    
    private override init() {
        let baseURL = URL(string: "ws://localhost:4000")!
        self.wsURL = baseURL
        super.init()
    }
    
    // MARK: - Connection Management
    
    func connect() {
        guard connectionStatus != .connected && connectionStatus != .connecting else { return }
        
        connectionStatus = .connecting
        let request = URLRequest(url: wsURL)
        webSocket = URLSession.shared.webSocketTask(with: request)
        webSocket?.delegate = self
        webSocket?.resume()
        
        print("WebSocket: Attempting to connect to \(wsURL.absoluteString)")
        receiveMessage()
    }
    
    func disconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        reconnectAttempts = 0
        webSocket?.cancel(with: .goingAway, reason: nil)
        connectionStatus = .disconnected
    }
    
    private func scheduleReconnect() {
        guard reconnectAttempts < maxReconnectAttempts else {
            connectionStatus = .disconnected
            print("WebSocket: Max reconnection attempts reached")
            return
        }
        
        reconnectAttempts += 1
        connectionStatus = .reconnecting
        
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: reconnectInterval, repeats: false) { [weak self] _ in
            self?.connect()
        }
        
        print("WebSocket: Scheduling reconnect attempt \(reconnectAttempts) in \(reconnectInterval)s")
    }
    
    // MARK: - Message Sending
    
    func identify(userId: String, userName: String, seat: String?) {
        let message: [String: Any] = [
            "type": "identify",
            "userId": userId,
            "userName": userName,
            "seat": seat ?? NSNull()
        ]
        send(message: message)
    }
    
    func takeSeat(tableId: String) {
        let message: [String: Any] = [
            "type": "take_seat",
            "tableId": tableId
        ]
        send(message: message)
    }
    
    func sendDrink(toUserId: String, toUserName: String, drinkName: String, price: Double, tableName: String) {
        let message: [String: Any] = [
            "type": "send_drink",
            "toId": toUserId,
            "toName": toUserName,
            "drinkName": drinkName,
            "price": price,
            "tableName": tableName
        ]
        send(message: message)
    }
    
    func sendFlirt(toUserId: String, toUserName: String, emoji: String, message text: String) {
        let message: [String: Any] = [
            "type": "send_flirt",
            "toId": toUserId,
            "toName": toUserName,
            "emoji": emoji,
            "message": text
        ]
        send(message: message)
    }
    
    func ping() {
        let message: [String: Any] = ["type": "ping"]
        send(message: message)
    }
    
    private func send(message: [String: Any]) {
        guard connectionStatus == .connected, let webSocket = webSocket else {
            print("WebSocket: Not connected, cannot send message")
            return
        }
        
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: message)
            let jsonString = String(data: jsonData, encoding: .utf8) ?? ""
            print("WebSocket -> Sending: \(jsonString)")
            
            let message = URLSessionWebSocketTask.Message.string(jsonString)
            webSocket.send(message) { [weak self] error in
                if let error = error {
                    print("WebSocket: Error sending message: \(error.localizedDescription)")
                    self?.scheduleReconnect()
                }
            }
        } catch {
            print("WebSocket: Error encoding message: \(error.localizedDescription)")
        }
    }
    
    // MARK: - Message Receiving
    
    private func receiveMessage() {
        guard let webSocket = webSocket else { return }
        
        webSocket.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let jsonString):
                    self?.handleMessage(jsonString)
                case .data(let data):
                    if let jsonString = String(data: data, encoding: .utf8) {
                        self?.handleMessage(jsonString)
                    }
                @unknown default:
                    break
                }
                
                // Continue receiving
                self?.receiveMessage()
                
            case .failure(let error):
                print("WebSocket: Error receiving message: \(error.localizedDescription)")
                self?.scheduleReconnect()
            }
        }
    }
    
    private func handleMessage(_ jsonString: String) {
        print("WebSocket <- Received: \(jsonString)")
        
        guard let data = jsonString.data(using: .utf8) else { return }
        
        do {
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let type = json["type"] as? String {
                
                switch type {
                case "snapshot":
                    if let state = try? JSONDecoder().decode(SharedState.self, from: data) {
                        DispatchQueue.main.async {
                            self.onStateUpdate?(state)
                        }
                    }
                    
                case "state":
                    if let state = try? JSONDecoder().decode(SharedState.self, from: data) {
                        DispatchQueue.main.async {
                            self.onStateUpdate?(state)
                        }
                    }
                    
                case "activity":
                    if let item = try? JSONDecoder().decode(ActivityItem.self, from: json["item"] as? [String: Any] ?? [:]) {
                        DispatchQueue.main.async {
                            self.onActivityUpdate?(item)
                        }
                    }
                    
                case "presence":
                    if let presenceData = try? JSONSerialization.data(withJSONObject: json["presence"] as? [[String: Any]] ?? []),
                       let presence = try? JSONDecoder().decode([PresenceUser].self, from: presenceData) {
                        DispatchQueue.main.async {
                            self.onPresenceUpdate?(presence)
                        }
                    }
                    
                case "pong":
                    print("WebSocket: Pong received")
                    
                default:
                    break
                }
            }
        } catch {
            print("WebSocket: Error parsing message: \(error.localizedDescription)")
        }
    }
    
    // MARK: - URLSessionWebSocketDelegate
    
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        print("WebSocket: Connected")
        connectionStatus = .connected
        reconnectAttempts = 0
    }
    
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("WebSocket: Closed (code: \(closeCode.rawValue))")
        scheduleReconnect()
    }
}
