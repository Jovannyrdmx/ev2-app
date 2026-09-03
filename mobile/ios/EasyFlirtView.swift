import SwiftUI

struct EasyFlirtView: View {
    @StateObject private var viewModel = EasyFlirtViewModel()
    
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Header with connection status
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Easy Flirt")
                            .font(.headline)
                            .fontWeight(.bold)
                        connectionStatusBadge
                    }
                    Spacer()
                    if let userName = viewModel.currentUser?.id?.prefix(8) {
                        Text("User \(userName)")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                }
                .padding()
                .background(Color(UIColor.systemGray6))
                
                // Main content
                if viewModel.tables.isEmpty {
                    loadingView
                } else {
                    tablesListView
                }
                
                Spacer()
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task {
            await viewModel.initializeUser()
        }
    }
    
    // MARK: - Subviews
    
    @ViewBuilder
    private var connectionStatusBadge: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(connectionStatusColor)
                .frame(width: 6, height: 6)
            
            Text(connectionStatusText)
                .font(.caption2)
                .foregroundColor(connectionStatusColor)
        }
    }
    
    private var connectionStatusColor: Color {
        switch viewModel.connectionStatus {
        case .connected:
            return .green
        case .connecting, .reconnecting:
            return .orange
        case .disconnected:
            return .red
        }
    }
    
    private var connectionStatusText: String {
        switch viewModel.connectionStatus {
        case .connected:
            return "Connected"
        case .connecting:
            return "Connecting…"
        case .reconnecting:
            return "Reconnecting…"
        case .disconnected:
            return "Offline"
        }
    }
    
    @ViewBuilder
    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading tables…")
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(UIColor.systemBackground))
    }
    
    @ViewBuilder
    private var tablesListView: some View {
        List {
            ForEach(viewModel.tables.values.sorted(by: { $0.name < $1.name }), id: \.id) { table in
                tableRowView(table)
            }
        }
        .listStyle(.plain)
    }
    
    @ViewBuilder
    private func tableRowView(_ table: WebSocketManager.TableState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(table.name)
                        .font(.headline)
                    Text(table.section.uppercased())
                        .font(.caption)
                        .foregroundColor(.gray)
                }
                
                Spacer()
                
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(table.occupants.count)/\(table.capacity)")
                        .font(.caption)
                        .foregroundColor(.gray)
                    
                    HStack(spacing: 4) {
                        ForEach(table.occupants.prefix(3), id: \.id) { occupant in
                            Image(systemName: "person.fill")
                                .font(.caption)
                                .foregroundColor(.blue)
                        }
                        if table.occupants.count > 3 {
                            Text("+\(table.occupants.count - 3)")
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                    }
                }
            }
            
            HStack(spacing: 8) {
                Button(action: { viewModel.selectTable(table.id) }) {
                    Label("Sit", systemImage: "person.badge.plus")
                        .font(.caption)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                
                if table.occupants.count > 0 {
                    Button(action: { viewModel.sendDrink(
                        toUserId: table.occupants[0].id,
                        toUserName: table.occupants[0].name,
                        drinkName: "Margarita",
                        price: 11.0
                    ) }) {
                        Label("Drink", systemImage: "wineglass")
                            .font(.caption)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.orange)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    EasyFlirtView()
}
