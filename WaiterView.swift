import SwiftUI

@MainActor
class WaiterViewModel: ObservableObject {
    @Published var waiterId: String?
    @Published var restaurantId: String?
    @Published var assignedTables: [TableAssignment] = []
    @Published var pendingDrinkOrders: [DrinkOrder] = []
    @Published var notifications: [WaiterNotification] = []
    @Published var isCheckedIn = false
    @Published var errorMessage: String?
    
    private let waiterService = WaiterService.shared
    private let webSocket = WebSocketManager.shared
    private let authManager = AuthManager.shared
    
    func initialize(waiterId: String, restaurantId: String) {
        self.waiterId = waiterId
        self.restaurantId = restaurantId
        
        webSocket.setupRestaurantHandlers()
        setupHandlers()
    }
    
    private func setupHandlers() {
        webSocket.onDrinkOrderUpdate = { [weak self] drinkOrder in
            DispatchQueue.main.async {
                if drinkOrder.status == .ready {
                    self?.pendingDrinkOrders.removeAll { $0.id == drinkOrder.id }
                    self?.pendingDrinkOrders.insert(drinkOrder, at: 0)
                }
            }
        }
        
        webSocket.onNotification = { [weak self] notification in
            DispatchQueue.main.async {
                self?.notifications.insert(notification, at: 0)
            }
        }
        
        webSocket.onTableAssignmentUpdate = { [weak self] assignment in
            DispatchQueue.main.async {
                if let index = self?.assignedTables.firstIndex(where: { $0.id == assignment.id }) {
                    self?.assignedTables[index] = assignment
                } else {
                    self?.assignedTables.append(assignment)
                }
            }
        }
    }
    
    func checkIn() async {
        guard let waiterId = waiterId, let restaurantId = restaurantId else { return }
        
        do {
            try await waiterService.checkIn(restaurantId: restaurantId, waiterId: waiterId)
            DispatchQueue.main.async {
                self.isCheckedIn = true
            }
            
            // Connect WebSocket for real-time updates
            webSocket.connect()
            webSocket.identify(userId: waiterId, userName: "Waiter", seat: nil)
            
            // Fetch initial data
            await refreshData()
        } catch {
            self.errorMessage = "Check-in failed: \(error.localizedDescription)"
        }
    }
    
    func checkOut() async {
        guard let waiterId = waiterId, let restaurantId = restaurantId else { return }
        
        do {
            try await waiterService.checkOut(restaurantId: restaurantId, waiterId: waiterId)
            DispatchQueue.main.async {
                self.isCheckedIn = false
                self.assignedTables = []
                self.pendingDrinkOrders = []
            }
            
            webSocket.disconnect()
        } catch {
            self.errorMessage = "Check-out failed: \(error.localizedDescription)"
        }
    }
    
    func refreshData() async {
        guard let waiterId = waiterId, let restaurantId = restaurantId else { return }
        
        do {
            async let tables = waiterService.fetchAssignedTables(restaurantId: restaurantId, waiterId: waiterId)
            async let drinks = waiterService.fetchPendingDrinkOrders(restaurantId: restaurantId, waiterId: waiterId)
            async let notifs = waiterService.fetchNotifications(restaurantId: restaurantId, waiterId: waiterId, unreadOnly: true)
            
            let (fetchedTables, fetchedDrinks, fetchedNotifs) = try await (tables, drinks, notifs)
            
            DispatchQueue.main.async {
                self.assignedTables = fetchedTables
                self.pendingDrinkOrders = fetchedDrinks
                self.notifications = fetchedNotifs
            }
        } catch {
            self.errorMessage = "Failed to refresh data: \(error.localizedDescription)"
        }
    }
    
    func deliverDrink(_ drinkOrder: DrinkOrder) async {
        guard let restaurantId = restaurantId else { return }
        
        do {
            let updated = try await waiterService.confirmDrinkDelivery(restaurantId: restaurantId, drinkOrderId: drinkOrder.id)
            
            DispatchQueue.main.async {
                self.pendingDrinkOrders.removeAll { $0.id == drinkOrder.id }
            }
            
            webSocket.updateDrinkOrderStatus(drinkOrderId: drinkOrder.id, status: .delivered)
        } catch {
            self.errorMessage = "Failed to confirm delivery: \(error.localizedDescription)"
        }
    }
    
    func markNotificationAsRead(_ notification: WaiterNotification) async {
        guard let restaurantId = restaurantId else { return }
        
        do {
            try await waiterService.markNotificationAsRead(restaurantId: restaurantId, notificationId: notification.id)
            
            DispatchQueue.main.async {
                if let index = self.notifications.firstIndex(where: { $0.id == notification.id }) {
                    self.notifications[index].read = true
                }
            }
        } catch {
            // Silent fail for notification reads
        }
    }
    
    func updateTableStatus(_ tableId: String, status: TableStatus) async {
        guard let restaurantId = restaurantId else { return }
        
        do {
            let _ = try await waiterService.updateTableStatus(restaurantId: restaurantId, tableId: tableId, status: status)
        } catch {
            self.errorMessage = "Failed to update table status: \(error.localizedDescription)"
        }
    }
}

struct WaiterView: View {
    @StateObject private var viewModel = WaiterViewModel()
    @State private var selectedTab: WaiterTab = .drinks
    @State private var showCheckOutAlert = false
    
    enum WaiterTab {
        case drinks
        case tables
        case notifications
    }
    
    let waiterId: String
    let restaurantId: String
    
    var body: some View {
        ZStack {
            TabView(selection: $selectedTab) {
                // Drinks Tab
                drinksTab
                    .tag(WaiterTab.drinks)
                    .tabItem {
                        Label("Drinks", systemImage: "wineglass")
                    }
                
                // Tables Tab
                tablesTab
                    .tag(WaiterTab.tables)
                    .tabItem {
                        Label("Tables", systemImage: "table.furniture")
                    }
                
                // Notifications Tab
                notificationsTab
                    .tag(WaiterTab.notifications)
                    .tabItem {
                        Label("Alerts", systemImage: "bell.badge")
                    }
            }
            
            // Floating action for check-in/out
            VStack {
                HStack {
                    Text(viewModel.isCheckedIn ? "Checked In" : "Checked Out")
                        .font(.caption)
                        .foregroundColor(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(viewModel.isCheckedIn ? Color.green : Color.gray)
                        .cornerRadius(6)
                    
                    Spacer()
                    
                    Button(action: { showCheckOutAlert = true }) {
                        Image(systemName: viewModel.isCheckedIn ? "rectangle.portrait.and.arrow.right" : "rectangle.portrait.and.arrow.left")
                            .font(.title3)
                    }
                    .padding()
                }
                .padding()
                .background(Color(UIColor.systemGray6))
                
                Spacer()
            }
        }
        .onAppear {
            viewModel.initialize(waiterId: waiterId, restaurantId: restaurantId)
            Task { await viewModel.checkIn() }
        }
        .alert("Check Out", isPresented: $showCheckOutAlert) {
            Button("Check Out", role: .destructive) {
                Task { await viewModel.checkOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Are you sure you want to check out?")
        }
        .alert("Error", isPresented: .constant(viewModel.errorMessage != nil)) {
            Button("Dismiss") { viewModel.errorMessage = nil }
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }
    
    // MARK: - Tabs
    
    @ViewBuilder
    private var drinksTab: some View {
        VStack {
            if viewModel.pendingDrinkOrders.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 50))
                        .foregroundColor(.green)
                    Text("All Caught Up!")
                        .font(.headline)
                    Text("No pending drinks")
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(UIColor.systemBackground))
            } else {
                List {
                    ForEach(viewModel.pendingDrinkOrders) { drink in
                        drinkOrderRow(drink)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Pending Drinks")
    }
    
    @ViewBuilder
    private func drinkOrderRow(_ drink: DrinkOrder) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(drink.drink.name) - $\(String(format: "%.2f", drink.drink.price))")
                        .font(.headline)
                    Text("From: \(drink.senderName)")
                        .font(.caption)
                        .foregroundColor(.gray)
                    Text("To: \(drink.recipientName) at \(drink.tableName)")
                        .font(.caption)
                        .foregroundColor(.blue)
                }
                
                Spacer()
                
                VStack(alignment: .trailing, spacing: 4) {
                    Text(drink.status.rawValue.uppercased())
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange)
                        .foregroundColor(.white)
                        .cornerRadius(4)
                    
                    if drink.drink.preparationTime ?? 0 > 0 {
                        Text("\(drink.drink.preparationTime ?? 0)s")
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                }
            }
            
            if let message = drink.message {
                Text("Message: \(message)")
                    .font(.caption)
                    .foregroundColor(.gray)
                    .italic()
            }
            
            Button(action: {
                Task { await viewModel.deliverDrink(drink) }
            }) {
                Label("Mark Delivered", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.green)
                    .foregroundColor(.white)
                    .cornerRadius(6)
            }
        }
        .padding(.vertical, 4)
    }
    
    @ViewBuilder
    private var tablesTab: some View {
        VStack {
            if viewModel.assignedTables.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "table.furniture")
                        .font(.system(size: 50))
                        .foregroundColor(.gray)
                    Text("No Tables Assigned")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(UIColor.systemBackground))
            } else {
                List {
                    ForEach(viewModel.assignedTables) { table in
                        tableRow(table)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("My Tables")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: {
                    Task { await viewModel.refreshData() }
                }) {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
    }
    
    @ViewBuilder
    private func tableRow(_ table: TableAssignment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(table.tableName)
                    .font(.headline)
                
                Spacer()
                
                Text(table.status.rawValue.uppercased())
                    .font(.caption2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor(table.status))
                    .foregroundColor(.white)
                    .cornerRadius(4)
            }
            
            HStack(spacing: 12) {
                Button(action: {
                    Task { await viewModel.updateTableStatus(table.tableId, status: .occupied) }
                }) {
                    Label("Occupied", systemImage: "person.fill")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                
                Button(action: {
                    Task { await viewModel.updateTableStatus(table.tableId, status: .cleaning) }
                }) {
                    Label("Cleaning", systemImage: "sparkles")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                
                Button(action: {
                    Task { await viewModel.updateTableStatus(table.tableId, status: .available) }
                }) {
                    Label("Ready", systemImage: "checkmark.circle")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }
    
    @ViewBuilder
    private var notificationsTab: some View {
        VStack {
            if viewModel.notifications.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "bell.slash")
                        .font(.system(size: 50))
                        .foregroundColor(.gray)
                    Text("No Notifications")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(UIColor.systemBackground))
            } else {
                List {
                    ForEach(viewModel.notifications) { notif in
                        notificationRow(notif)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Alerts")
    }
    
    @ViewBuilder
    private func notificationRow(_ notification: WaiterNotification) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(notification.title)
                        .font(.headline)
                    Text(notification.message)
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                
                Spacer()
                
                Text(priorityEmoji(notification.priority))
                    .font(.title3)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            Task { await viewModel.markNotificationAsRead(notification) }
        }
    }
    
    private func statusColor(_ status: TableStatus) -> Color {
        switch status {
        case .assigned:
            return .blue
        case .occupied:
            return .orange
        case .cleaning:
            return .yellow
        case .available:
            return .green
        }
    }
    
    private func priorityEmoji(_ priority: NotificationPriority) -> String {
        switch priority {
        case .low:
            return "ℹ️"
        case .normal:
            return "📌"
        case .high:
            return "⚠️"
        case .urgent:
            return "🚨"
        }
    }
}

#Preview {
    WaiterView(waiterId: "waiter-001", restaurantId: "rest-001")
}
