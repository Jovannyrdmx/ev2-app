import SwiftUI
import PassKit

// MARK: - Reservation Models
struct Reservation: Codable, Identifiable {
    let id: String
    let tableId: String
    let tableName: String
    let reservationDate: String
    let reservationTime: String
    let guestCount: Int
    let durationHours: Int
    let totalEstimated: Double
    let depositAmount: Double
    let status: String
    let paymentStatus: String
}

struct TableAvailability: Codable, Identifiable {
    let id: String
    let tableNumber: String
    let section: String
    let capacity: Int
    let priceTier: String
}

enum PaymentMethod: String, CaseIterable {
    case directDeposit = "direct_deposit"
    case zelle = "zelle"
    case applePay = "apple_pay"
    case googlePay = "google_pay"
    case cashApp = "cash_app"
    case paypal = "paypal"
    case cash = "cash"
    
    var displayName: String {
        switch self {
        case .directDeposit: return "Direct Deposit"
        case .zelle: return "Zelle"
        case .applePay: return "Apple Pay"
        case .googlePay: return "Google Pay"
        case .cashApp: return "Cash App"
        case .paypal: return "PayPal"
        case .cash: return "Cash at Door"
        }
    }
    
    var icon: String {
        switch self {
        case .directDeposit: return "banknote"
        case .zelle: return "building.2"
        case .applePay: return "apple.logo"
        case .googlePay: return "creditcard"
        case .cashApp: return "dollarsign.circle"
        case .paypal: return "p.circle"
        case .cash: return "wallet.pass"
        }
    }
}

// MARK: - Reservation View Model
@MainActor
class ReservationViewModel: ObservableObject {
    @Published var availableTables: [TableAvailability] = []
    @Published var selectedTable: TableAvailability?
    @Published var reservationDate = Date()
    @Published var reservationTime = Date()
    @Published var guestCount = 4
    @Published var durationHours = 3
    @Published var specialRequests = ""
    @Published var selectedAddons: [ReservationAddon] = []
    @Published var totalPrice = 0.0
    @Published var depositAmount = 0.0
    @Published var selectedPaymentMethod: PaymentMethod = .applePay
    @Published var userReservations: [Reservation] = []
    @Published var isProcessingPayment = false
    @Published var paymentError: String?
    
    private let api = ReservationAPI()
    
    func fetchAvailableTables(nightclubId: String, date: Date, startTime: Date, endTime: Date, guestCount: Int) async {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "HH:mm"
        
        do {
            availableTables = try await api.getAvailableTables(
                nightclubId: nightclubId,
                date: dateFormatter.string(from: date),
                startTime: timeFormatter.string(from: startTime),
                endTime: timeFormatter.string(from: endTime),
                guestCount: guestCount
            )
        } catch {
            paymentError = error.localizedDescription
        }
    }
    
    func calculatePrice() {
        let basePrice = 100.0 * Double(durationHours)
        let addonsTotal = selectedAddons.reduce(0) { $0 + $1.price }
        totalPrice = basePrice + addonsTotal
        depositAmount = totalPrice * 0.30 // 30% deposit
    }
    
    func createReservation(nightclubId: String) async {
        guard let selectedTable = selectedTable else { return }
        
        isProcessingPayment = true
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "HH:mm"
        
        do {
            let reservation = try await api.createReservation(
                nightclubId: nightclubId,
                tableId: selectedTable.id,
                date: dateFormatter.string(from: reservationDate),
                time: timeFormatter.string(from: reservationTime),
                guestCount: guestCount,
                durationHours: durationHours,
                specialRequests: specialRequests,
                addons: selectedAddons
            )
            
            // Process payment
            try await processPayment(reservationId: reservation.id, nightclubId: nightclubId)
            
            isProcessingPayment = false
        } catch {
            paymentError = error.localizedDescription
            isProcessingPayment = false
        }
    }
    
    func processPayment(reservationId: String, nightclubId: String) async throws {
        switch selectedPaymentMethod {
        case .applePay:
            try await processApplePay(reservationId: reservationId)
        case .zelle:
            try await api.processPayment(reservationId: reservationId, method: .zelle, details: [:])
        case .paypal:
            try await api.processPayment(reservationId: reservationId, method: .paypal, details: [:])
        case .cashApp:
            try await api.processPayment(reservationId: reservationId, method: .cashApp, details: [:])
        case .directDeposit:
            try await api.processPayment(reservationId: reservationId, method: .directDeposit, details: [:])
        case .cash:
            try await api.processPayment(reservationId: reservationId, method: .cash, details: [:])
        case .googlePay:
            try await api.processPayment(reservationId: reservationId, method: .googlePay, details: [:])
        }
    }
    
    func processApplePay(reservationId: String) async throws {
        let paymentRequest = PKPaymentRequest()
        paymentRequest.merchantIdentifier = "merchant.com.ev2clandestinoz"
        paymentRequest.countryCode = "US"
        paymentRequest.currencyCode = "USD"
        paymentRequest.supportedNetworks = [.visa, .masterCard, .amex]
        paymentRequest.merchantCapabilities = .capability3DS
        
        let summaryItem = PKPaymentSummaryItem(label: "EV2 Table Reservation", amount: NSDecimalNumber(value: depositAmount))
        paymentRequest.paymentSummaryItems = [summaryItem]
        
        // Present Apple Pay UI
        // This would be handled through PKPaymentAuthorizationViewController
    }
    
    func fetchUserReservations(nightclubId: String) async {
        do {
            userReservations = try await api.getUserReservations(nightclubId: nightclubId)
        } catch {
            paymentError = error.localizedDescription
        }
    }
}

// MARK: - Reservation API Service
class ReservationAPI {
    private let baseURL = "http://localhost:3000/api"
    
    func getAvailableTables(nightclubId: String, date: String, startTime: String, endTime: String, guestCount: Int) async throws -> [TableAvailability] {
        let url = URL(string: "\(baseURL)/nightclubs/\(nightclubId)/reservations/availability?date=\(date)&startTime=\(startTime)&endTime=\(endTime)&guestCount=\(guestCount)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode([TableAvailability].self, from: data)
    }
    
    func createReservation(nightclubId: String, tableId: String, date: String, time: String, guestCount: Int, durationHours: Int, specialRequests: String, addons: [ReservationAddon]) async throws -> Reservation {
        let url = URL(string: "\(baseURL)/nightclubs/\(nightclubId)/reservations")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = [
            "tableId": tableId,
            "reservationDate": date,
            "reservationTime": time,
            "guestCount": guestCount,
            "durationHours": durationHours,
            "specialRequests": specialRequests,
            "addons": addons
        ] as [String : Any]
        
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(["reservation": Reservation].self, from: data)
        return response["reservation"]!
    }
    
    func processPayment(reservationId: String, method: PaymentMethod, details: [String: Any]) async throws {
        let url = URL(string: "http://localhost:3000/api/reservations/\(reservationId)/pay")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = [
            "paymentMethod": method.rawValue,
            "paymentDetails": details
        ] as [String : Any]
        
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        _ = try await URLSession.shared.data(for: request)
    }
    
    func getUserReservations(nightclubId: String) async throws -> [Reservation] {
        let url = URL(string: "http://localhost:3000/api/nightclubs/\(nightclubId)/reservations/user")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode([Reservation].self, from: data)
    }
}

// MARK: - Models
struct ReservationAddon: Codable, Identifiable {
    let id = UUID()
    let type: String
    let name: String
    let price: Double
    let quantity: Int
}

// MARK: - Reservation Selection View
struct ReservationSelectionView: View {
    @StateObject private var viewModel = ReservationViewModel()
    @State private var showConfirmation = false
    let nightclubId: String
    
    var body: some View {
        NavigationStack {
            Form {
                Section("Reservation Details") {
                    DatePicker("Date", selection: $viewModel.reservationDate, displayedComponents: .date)
                    DatePicker("Time", selection: $viewModel.reservationTime, displayedComponents: .hourAndMinute)
                    
                    Stepper("Guests: \(viewModel.guestCount)", value: $viewModel.guestCount, in: 2...20)
                    Stepper("Duration: \(viewModel.durationHours)h", value: $viewModel.durationHours, in: 1...6)
                }
                
                Section("Special Requests") {
                    TextEditor(text: $viewModel.specialRequests)
                        .frame(height: 80)
                }
                
                Section("Available Tables") {
                    if viewModel.availableTables.isEmpty {
                        Text("No tables available")
                            .foregroundColor(.gray)
                    } else {
                        ForEach(viewModel.availableTables) { table in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(table.tableNumber)
                                        .fontWeight(.semibold)
                                    Text(table.section)
                                        .font(.caption)
                                        .foregroundColor(.gray)
                                }
                                Spacer()
                                if viewModel.selectedTable?.id == table.id {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(EV2Theme.cyan)
                                }
                            }
                            .onTapGesture {
                                viewModel.selectedTable = table
                                viewModel.calculatePrice()
                            }
                        }
                    }
                }
                
                Section("Price Breakdown") {
                    HStack {
                        Text("Base Price")
                        Spacer()
                        Text("$\(String(format: "%.2f", viewModel.totalPrice * 0.7))")
                    }
                    HStack {
                        Text("Deposit Required (30%)")
                        Spacer()
                        Text("$\(String(format: "%.2f", viewModel.depositAmount))")
                            .fontWeight(.semibold)
                            .foregroundColor(EV2Theme.cyan)
                    }
                }
                
                Section("Payment Method") {
                    Picker("Select Payment", selection: $viewModel.selectedPaymentMethod) {
                        ForEach(PaymentMethod.allCases, id: \.self) { method in
                            HStack {
                                Image(systemName: method.icon)
                                Text(method.displayName)
                            }
                            .tag(method)
                        }
                    }
                }
            }
            .navigationTitle("Reserve a Table")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { showConfirmation = true }) {
                        if viewModel.isProcessingPayment {
                            ProgressView()
                        } else {
                            Text("Reserve & Pay")
                        }
                    }
                    .disabled(viewModel.selectedTable == nil || viewModel.isProcessingPayment)
                }
            }
            .alert("Payment Error", isPresented: .constant(viewModel.paymentError != nil)) {
                Button("OK") { viewModel.paymentError = nil }
            } message: {
                Text(viewModel.paymentError ?? "")
            }
            .task {
                await viewModel.fetchAvailableTables(
                    nightclubId: nightclubId,
                    date: viewModel.reservationDate,
                    startTime: viewModel.reservationTime,
                    endTime: viewModel.reservationTime.addingTimeInterval(3600),
                    guestCount: viewModel.guestCount
                )
            }
        }
    }
}

// MARK: - Payment Sheet View
struct PaymentSheetView: View {
    let reservation: Reservation
    @ObservedObject var viewModel: ReservationViewModel
    @Environment(\.dismiss) var dismiss
    
    var body: some View {
        VStack(spacing: 20) {
            Text("Complete Payment")
                .font(.title2)
                .fontWeight(.bold)
            
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Deposit Amount:")
                    Spacer()
                    Text("$\(String(format: "%.2f", viewModel.depositAmount))")
                        .fontWeight(.semibold)
                        .foregroundColor(EV2Theme.cyan)
                }
                
                HStack {
                    Text("Payment Method:")
                    Spacer()
                    Text(viewModel.selectedPaymentMethod.displayName)
                }
                
                if viewModel.selectedPaymentMethod == .directDeposit {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Bank Details")
                            .font(.caption)
                            .fontWeight(.semibold)
                        
                        TextField("Account Holder", text: .constant(""))
                        TextField("Account Number", text: .constant(""))
                        TextField("Routing Number", text: .constant(""))
                        TextField("Bank Name", text: .constant(""))
                    }
                } else if viewModel.selectedPaymentMethod == .zelle {
                    TextField("Zelle Handle (@username or email)", text: .constant(""))
                } else if viewModel.selectedPaymentMethod == .cashApp {
                    TextField("Cash App Tag ($username)", text: .constant(""))
                }
            }
            .padding()
            .background(Color(.systemGray6))
            .cornerRadius(12)
            
            Button(action: {
                Task {
                    try await viewModel.processPayment(reservationId: reservation.id, nightclubId: "")
                    dismiss()
                }
            }) {
                Text(viewModel.isProcessingPayment ? "Processing..." : "Pay Deposit")
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(EV2Theme.gradient)
                    .foregroundColor(.white)
                    .cornerRadius(12)
            }
            .disabled(viewModel.isProcessingPayment)
            
            Spacer()
        }
        .padding()
        .navigationTitle("Payment")
    }
}

// MARK: - User Reservations View
struct UserReservationsView: View {
    @StateObject private var viewModel = ReservationViewModel()
    let nightclubId: String
    
    var body: some View {
        NavigationStack {
            List {
                if viewModel.userReservations.isEmpty {
                    Text("No reservations yet")
                        .foregroundColor(.gray)
                } else {
                    ForEach(viewModel.userReservations) { reservation in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(reservation.tableName)
                                        .fontWeight(.semibold)
                                    Text("\(reservation.guestCount) guests • \(reservation.durationHours)h")
                                        .font(.caption)
                                        .foregroundColor(.gray)
                                }
                                Spacer()
                                VStack(alignment: .trailing) {
                                    Text(reservation.reservationDate)
                                        .font(.caption)
                                    Text(reservation.reservationTime)
                                        .fontWeight(.semibold)
                                }
                            }
                            
                            HStack {
                                Text("Total: $\(String(format: "%.2f", reservation.totalEstimated))")
                                Spacer()
                                Text(reservation.status.uppercased())
                                    .font(.caption2)
                                    .fontWeight(.semibold)
                                    .foregroundColor(reservation.status == "confirmed" ? EV2Theme.lime : EV2Theme.cyan)
                            }
                        }
                    }
                }
            }
            .navigationTitle("My Reservations")
            .task {
                await viewModel.fetchUserReservations(nightclubId: nightclubId)
            }
        }
    }
}

#Preview {
    ReservationSelectionView(nightclubId: "test-123")
}
