import Foundation

// Extension to WebSocketManager for restaurant-specific events
extension WebSocketManager {
    
    // MARK: - Restaurant Event Handlers
    
    func setupRestaurantHandlers() {
        // Handle drink order updates
        self.onRestaurantMessage = { [weak self] message in
            if let eventType = message["event_type"] as? String {
                switch eventType {
                case "drink_order":
                    if let drinkData = message["data"] as? [String: Any],
                       let jsonData = try? JSONSerialization.data(withJSONObject: drinkData),
                       let drinkOrder = try? JSONDecoder().decode(DrinkOrder.self, from: jsonData) {
                        DispatchQueue.main.async {
                            self?.onDrinkOrderUpdate?(drinkOrder)
                        }
                    }
                    
                case "notification":
                    if let notifData = message["data"] as? [String: Any],
                       let jsonData = try? JSONSerialization.data(withJSONObject: notifData),
                       let notification = try? JSONDecoder().decode(WaiterNotification.self, from: jsonData) {
                        DispatchQueue.main.async {
                            self?.onNotification?(notification)
                        }
                    }
                    
                case "table_assignment":
                    if let tableData = message["data"] as? [String: Any],
                       let jsonData = try? JSONSerialization.data(withJSONObject: tableData),
                       let assignment = try? JSONDecoder().decode(TableAssignment.self, from: jsonData) {
                        DispatchQueue.main.async {
                            self?.onTableAssignmentUpdate?(assignment)
                        }
                    }
                    
                default:
                    break
                }
            }
        }
    }
    
    // MARK: - Send Restaurant Messages
    
    func submitDrinkOrder(drinkOrder: DrinkOrder) {
        let message: [String: Any] = [
            "type": "restaurant_event",
            "event_type": "drink_order",
            "action": "submit",
            "data": try? encodeToDict(drinkOrder) ?? [:]
        ]
        send(message: message)
    }
    
    func updateDrinkOrderStatus(drinkOrderId: String, status: DrinkOrderStatus) {
        let message: [String: Any] = [
            "type": "restaurant_event",
            "event_type": "drink_order",
            "action": "update_status",
            "drink_order_id": drinkOrderId,
            "status": status.rawValue
        ]
        send(message: message)
    }
    
    func notifyTableReady(tableId: String, waiterId: String) {
        let message: [String: Any] = [
            "type": "restaurant_event",
            "event_type": "table_ready",
            "table_id": tableId,
            "waiter_id": waiterId
        ]
        send(message: message)
    }
    
    func notifyWaiter(waiterId: String, notification: WaiterNotification) {
        let message: [String: Any] = [
            "type": "restaurant_event",
            "event_type": "notification",
            "waiter_id": waiterId,
            "data": try? encodeToDict(notification) ?? [:]
        ]
        send(message: message)
    }
    
    private func encodeToDict<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotDecodeRawData)
        }
        return dict
    }
}

// Update the main WebSocketManager class definition
extension WebSocketManager {
    var onRestaurantMessage: (([String: Any]) -> Void)? {
        get { objc_getAssociatedObject(self, &restMessageKey) as? ([String: Any]) -> Void }
        set { objc_setAssociatedObject(self, &restMessageKey, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }
    
    var onDrinkOrderUpdate: ((DrinkOrder) -> Void)? {
        get { objc_getAssociatedObject(self, &drinkOrderKey) as? (DrinkOrder) -> Void }
        set { objc_setAssociatedObject(self, &drinkOrderKey, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }
    
    var onNotification: ((WaiterNotification) -> Void)? {
        get { objc_getAssociatedObject(self, &notificationKey) as? (WaiterNotification) -> Void }
        set { objc_setAssociatedObject(self, &notificationKey, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }
    
    var onTableAssignmentUpdate: ((TableAssignment) -> Void)? {
        get { objc_getAssociatedObject(self, &tableAssignKey) as? (TableAssignment) -> Void }
        set { objc_setAssociatedObject(self, &tableAssignKey, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }
}

private var restMessageKey = "restMessageKey"
private var drinkOrderKey = "drinkOrderKey"
private var notificationKey = "notificationKey"
private var tableAssignKey = "tableAssignKey"
