import SwiftUI

// MARK: - EV2 Branding
struct EV2Theme {
    static let cyan = Color(red: 0, green: 0.75, blue: 1.0)      // #00BFFF
    static let pink = Color(red: 1.0, green: 0.08, blue: 0.58)   // #FF1493
    static let purple = Color(red: 0.62, green: 0, blue: 1.0)    // #9D00FF
    static let lime = Color(red: 0, green: 1.0, blue: 0)         // #00FF00
    static let gold = Color(red: 1.0, green: 0.84, blue: 0)      // #FFD700
    static let darkBg = Color(red: 0.04, green: 0.04, blue: 0.08) // #0a0a14
    
    static let gradient = LinearGradient(
        gradient: Gradient(colors: [cyan, pink, purple, lime, gold]),
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

// MARK: - EV2 Loading Screen
struct EV2LoadingScreen: View {
    @State private var isVisible = true
    
    var body: some View {
        ZStack {
            // Dark background with gradient
            LinearGradient(
                gradient: Gradient(colors: [
                    EV2Theme.darkBg,
                    Color(red: 0.1, green: 0.0, blue: 0.2),
                    Color(red: 0.0, green: 0.1, blue: 0.2)
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
            
            if isVisible {
                VStack(spacing: 24) {
                    // EV2 Logo
                    ZStack {
                        // Glow effect
                        Circle()
                            .fill(EV2Theme.cyan)
                            .opacity(0.2)
                            .blur(radius: 20)
                        
                        // Logo card
                        VStack {
                            Text("EV2")
                                .font(.system(size: 72, weight: .bold, design: .default))
                                .foregroundStyle(EV2Theme.gradient)
                            
                            Text("CLANDESTINOZ")
                                .font(.system(size: 10, weight: .semibold, design: .default))
                                .tracking(2)
                                .foregroundColor(EV2Theme.cyan)
                        }
                        .frame(width: 160, height: 160)
                        .background(Color.black.opacity(0.4))
                        .cornerRadius(20)
                        .border(EV2Theme.cyan, width: 3)
                    }
                    .frame(width: 200, height: 200)
                    
                    // Loading text
                    VStack(spacing: 8) {
                        Text("EASY FLIRT")
                            .font(.system(size: 28, weight: .bold, design: .default))
                            .foregroundStyle(EV2Theme.gradient)
                        
                        Text("The hottest nightclub in Nogales")
                            .font(.system(size: 12, weight: .medium, design: .default))
                            .foregroundColor(EV2Theme.cyan)
                    }
                    
                    // Animated dots
                    HStack(spacing: 8) {
                        ForEach(0..<3, id: \.self) { index in
                            Circle()
                                .fill(index == 0 ? EV2Theme.cyan : (index == 1 ? EV2Theme.pink : EV2Theme.purple))
                                .frame(width: 8, height: 8)
                                .scaleEffect(1.0)
                                .animation(
                                    Animation.easeInOut(duration: 0.6)
                                        .repeatForever()
                                        .delay(Double(index) * 0.15),
                                    value: UUID()
                                )
                        }
                    }
                    
                    Text("STEPPING INTO THE CLUB...")
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .tracking(2)
                        .foregroundColor(EV2Theme.cyan.opacity(0.6))
                }
                .transition(.opacity)
            }
        }
        .onTapGesture {
            withAnimation(.easeOut(duration: 0.3)) {
                isVisible = false
            }
        }
    }
}

// MARK: - EV2 Login View
struct EV2LoginView: View {
    @State private var email = "guest@ev2clandestinoz.com"
    @State private var name = "Guest"
    @State private var isLoading = false
    @State private var navigateToMain = false
    
    var body: some View {
        NavigationStack {
            ZStack {
                // Background gradient
                LinearGradient(
                    gradient: Gradient(colors: [
                        EV2Theme.darkBg,
                        Color(red: 0.1, green: 0.0, blue: 0.2)
                    ]),
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .ignoresSafeArea()
                
                ScrollView {
                    VStack(spacing: 24) {
                        // Header with logo
                        VStack(spacing: 16) {
                            ZStack {
                                Circle()
                                    .fill(EV2Theme.cyan)
                                    .opacity(0.15)
                                    .blur(radius: 30)
                                
                                VStack {
                                    Text("EV2")
                                        .font(.system(size: 56, weight: .bold))
                                        .foregroundStyle(EV2Theme.gradient)
                                    
                                    Text("CLANDESTINOZ")
                                        .font(.system(size: 9, weight: .bold))
                                        .tracking(2)
                                        .foregroundColor(EV2Theme.cyan)
                                }
                                .frame(height: 140)
                                .background(Color.black.opacity(0.3))
                                .cornerRadius(16)
                                .border(EV2Theme.cyan, width: 2)
                            }
                            
                            VStack(spacing: 8) {
                                Text("Welcome to EV2")
                                    .font(.system(size: 20, weight: .bold))
                                    .foregroundStyle(EV2Theme.gradient)
                                
                                Text("The hottest nightclub in Nogales")
                                    .font(.system(size: 12))
                                    .foregroundColor(EV2Theme.cyan)
                            }
                        }
                        .padding(.top, 20)
                        
                        // Login form
                        VStack(spacing: 12) {
                            TextField("Email", text: $email)
                                .textInputAutocapitalization(.none)
                                .keyboardType(.emailAddress)
                                .padding(12)
                                .background(Color.white.opacity(0.05))
                                .border(EV2Theme.cyan.opacity(0.3), width: 1)
                                .cornerRadius(12)
                                .foregroundColor(.white)
                            
                            TextField("Your name", text: $name)
                                .padding(12)
                                .background(Color.white.opacity(0.05))
                                .border(EV2Theme.cyan.opacity(0.3), width: 1)
                                .cornerRadius(12)
                                .foregroundColor(.white)
                            
                            Button(action: { enterClub() }) {
                                HStack {
                                    Image(systemName: "arrow.right.circle.fill")
                                    Text("Enter the Club")
                                        .fontWeight(.semibold)
                                }
                                .frame(maxWidth: .infinity)
                                .padding(14)
                                .background(EV2Theme.gradient)
                                .foregroundColor(.white)
                                .cornerRadius(12)
                                .shadow(color: EV2Theme.cyan.opacity(0.5), radius: 10)
                            }
                            .disabled(isLoading)
                        }
                        .padding(.horizontal)
                        
                        Divider()
                            .background(EV2Theme.cyan.opacity(0.3))
                        
                        // Instagram login
                        Button(action: { loginWithInstagram() }) {
                            HStack {
                                Image(systemName: "camera.fill")
                                Text("Continue with Instagram")
                                    .fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(14)
                            .background(
                                LinearGradient(
                                    gradient: Gradient(colors: [
                                        Color(red: 0.9, green: 0.2, blue: 0.4),
                                        Color(red: 0.76, green: 0.08, blue: 0.52)
                                    ]),
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .foregroundColor(.white)
                            .cornerRadius(12)
                        }
                        .padding(.horizontal)
                        
                        // Footer
                        VStack(spacing: 4) {
                            Text("18+ only • EV2 Clandestinoz")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(EV2Theme.cyan.opacity(0.7))
                            
                            Text("By entering, you agree to our Terms")
                                .font(.system(size: 9))
                                .foregroundColor(EV2Theme.cyan.opacity(0.5))
                        }
                        .padding(.top, 20)
                    }
                    .padding(.vertical)
                }
                
                // Loading overlay
                if isLoading {
                    ZStack {
                        Color.black.opacity(0.4)
                        VStack {
                            ProgressView()
                                .tint(EV2Theme.cyan)
                            Text("Entering the club...")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(EV2Theme.cyan)
                        }
                    }
                }
            }
            .navigationDestination(isPresented: $navigateToMain) {
                EasyFlirtView()
                    .navigationBarBackButtonHidden(true)
            }
        }
    }
    
    private func enterClub() {
        isLoading = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            isLoading = false
            navigateToMain = true
        }
    }
    
    private func loginWithInstagram() {
        isLoading = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            isLoading = false
            navigateToMain = true
        }
    }
}

// MARK: - EV2 Main App
struct EasyFlirtView: View {
    var body: some View {
        VStack {
            // Header with EV2 branding
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("EV2")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(EV2Theme.gradient)
                    
                    Text("CLANDESTINOZ")
                        .font(.system(size: 8, weight: .bold))
                        .tracking(1)
                        .foregroundColor(EV2Theme.cyan)
                }
                
                Spacer()
                
                HStack(spacing: 4) {
                    Circle()
                        .fill(EV2Theme.lime)
                        .frame(width: 6, height: 6)
                    
                    Text("LIVE")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(EV2Theme.lime)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(EV2Theme.lime.opacity(0.2))
                .cornerRadius(6)
            }
            .padding()
            .background(Color.black.opacity(0.3))
            .border(EV2Theme.cyan.opacity(0.2), width: 1)
            
            // Main content
            TabView {
                Text("Map View").tag(0)
                Text("Activity").tag(1)
                Text("Profile").tag(2)
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
        }
        .background(
            LinearGradient(
                gradient: Gradient(colors: [
                    EV2Theme.darkBg,
                    Color(red: 0.1, green: 0.0, blue: 0.2)
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
    }
}

#Preview {
    EV2LoginView()
}
