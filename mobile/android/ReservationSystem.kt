// Android Kotlin - Complete Reservation System with Payment

package com.ev2clandestinoz.easyflirt.ui.reservations

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter

// ==================== DATA MODELS ====================

data class Reservation(
    val id: String,
    val tableId: String,
    val tableName: String,
    val reservationDate: String,
    val reservationTime: String,
    val guestCount: Int,
    val durationHours: Int,
    val totalEstimated: Double,
    val depositAmount: Double,
    val status: String,
    val paymentStatus: String
)

data class TableAvailability(
    val id: String,
    val tableNumber: String,
    val section: String,
    val capacity: Int,
    val priceTier: String
)

enum class PaymentMethod(
    val displayName: String,
    val icon: String,
    val rawValue: String
) {
    DIRECT_DEPOSIT("Direct Deposit", "account_balance_wallet", "direct_deposit"),
    ZELLE("Zelle", "hub", "zelle"),
    APPLE_PAY("Apple Pay", "payment", "apple_pay"),
    GOOGLE_PAY("Google Pay", "payment", "google_pay"),
    CASH_APP("Cash App", "local_activity", "cash_app"),
    PAYPAL("PayPal", "shop_two", "paypal"),
    CASH("Cash at Door", "money", "cash")
}

// ==================== VIEW MODEL ====================

class ReservationViewModel : ViewModel() {
    private val _availableTables = mutableStateOf<List<TableAvailability>>(emptyList())
    val availableTables: State<List<TableAvailability>> = _availableTables
    
    private val _selectedTable = mutableStateOf<TableAvailability?>(null)
    val selectedTable: State<TableAvailability?> = _selectedTable
    
    private val _reservationDate = mutableStateOf(LocalDate.now())
    val reservationDate: State<LocalDate> = _reservationDate
    
    private val _reservationTime = mutableStateOf(LocalTime.of(20, 0))
    val reservationTime: State<LocalTime> = _reservationTime
    
    private val _guestCount = mutableStateOf(4)
    val guestCount: State<Int> = _guestCount
    
    private val _durationHours = mutableStateOf(3)
    val durationHours: State<Int> = _durationHours
    
    private val _totalPrice = mutableStateOf(0.0)
    val totalPrice: State<Double> = _totalPrice
    
    private val _depositAmount = mutableStateOf(0.0)
    val depositAmount: State<Double> = _depositAmount
    
    private val _selectedPaymentMethod = mutableStateOf(PaymentMethod.GOOGLE_PAY)
    val selectedPaymentMethod: State<PaymentMethod> = _selectedPaymentMethod
    
    private val _userReservations = mutableStateOf<List<Reservation>>(emptyList())
    val userReservations: State<List<Reservation>> = _userReservations
    
    private val _isProcessingPayment = mutableStateOf(false)
    val isProcessingPayment: State<Boolean> = _isProcessingPayment
    
    private val _paymentError = mutableStateOf<String?>(null)
    val paymentError: State<String?> = _paymentError
    
    fun setSelectedTable(table: TableAvailability) {
        _selectedTable.value = table
        calculatePrice()
    }
    
    fun setGuestCount(count: Int) {
        _guestCount.value = count
        calculatePrice()
    }
    
    fun setDurationHours(hours: Int) {
        _durationHours.value = hours
        calculatePrice()
    }
    
    fun setPaymentMethod(method: PaymentMethod) {
        _selectedPaymentMethod.value = method
    }
    
    fun calculatePrice() {
        val basePrice = 100.0 * _durationHours.value
        _totalPrice.value = basePrice
        _depositAmount.value = basePrice * 0.30 // 30% deposit
    }
    
    fun createReservation(
        nightclubId: String,
        specialRequests: String,
        onSuccess: (Reservation) -> Unit,
        onError: (String) -> Unit
    ) {
        viewModelScope.launch {
            _isProcessingPayment.value = true
            try {
                val table = _selectedTable.value ?: return@launch
                val dateFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
                val timeFormatter = DateTimeFormatter.ofPattern("HH:mm")
                
                // API call to create reservation
                val reservation = Reservation(
                    id = "res-${System.currentTimeMillis()}",
                    tableId = table.id,
                    tableName = table.tableNumber,
                    reservationDate = _reservationDate.value.format(dateFormatter),
                    reservationTime = _reservationTime.value.format(timeFormatter),
                    guestCount = _guestCount.value,
                    durationHours = _durationHours.value,
                    totalEstimated = _totalPrice.value,
                    depositAmount = _depositAmount.value,
                    status = "pending",
                    paymentStatus = "pending"
                )
                
                // Process payment
                processPayment(reservation.id, nightclubId, onSuccess, onError)
                
                _isProcessingPayment.value = false
                onSuccess(reservation)
            } catch (e: Exception) {
                _paymentError.value = e.message
                onError(e.message ?: "Unknown error")
                _isProcessingPayment.value = false
            }
        }
    }
    
    fun processPayment(
        reservationId: String,
        nightclubId: String,
        onSuccess: (Reservation) -> Unit,
        onError: (String) -> Unit
    ) {
        viewModelScope.launch {
            try {
                when (_selectedPaymentMethod.value) {
                    PaymentMethod.GOOGLE_PAY -> {
                        // Google Pay processing
                        _paymentError.value = null
                    }
                    PaymentMethod.APPLE_PAY -> {
                        // Apple Pay processing
                        _paymentError.value = null
                    }
                    PaymentMethod.PAYPAL -> {
                        // PayPal processing
                        _paymentError.value = null
                    }
                    PaymentMethod.ZELLE -> {
                        // Zelle processing
                        _paymentError.value = null
                    }
                    PaymentMethod.CASH_APP -> {
                        // Cash App processing
                        _paymentError.value = null
                    }
                    PaymentMethod.DIRECT_DEPOSIT -> {
                        // Direct deposit info
                        _paymentError.value = null
                    }
                    PaymentMethod.CASH -> {
                        // Cash payment
                        _paymentError.value = null
                    }
                }
            } catch (e: Exception) {
                _paymentError.value = e.message
                onError(e.message ?: "Payment failed")
            }
        }
    }
    
    fun fetchUserReservations(nightclubId: String) {
        viewModelScope.launch {
            try {
                // API call to fetch reservations
                _userReservations.value = emptyList() // Replace with API response
            } catch (e: Exception) {
                _paymentError.value = e.message
            }
        }
    }
}

// ==================== RESERVATION SELECTION SCREEN ====================

@Composable
fun ReservationSelectionScreen(
    nightclubId: String,
    viewModel: ReservationViewModel = androidx.lifecycle.viewmodel.compose.viewModel(),
    onReservationComplete: (Reservation) -> Unit
) {
    var specialRequests by remember { mutableStateOf("") }
    var showPaymentSheet by remember { mutableStateOf(false) }
    var createdReservation by remember { mutableStateOf<Reservation?>(null) }
    
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(EV2Colors.DarkBg)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item {
            Text(
                "Reserve a Table",
                fontSize = 24.sp,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                color = Color.White
            )
        }
        
        // Date & Time Section
        item {
            SectionHeader("When")
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // Date picker would go here
                OutlinedButton(
                    onClick = { /* Show date picker */ },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = EV2Colors.Cyan
                    )
                ) {
                    Text(viewModel.reservationDate.value.toString())
                }
                
                OutlinedButton(
                    onClick = { /* Show time picker */ },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(
                        contentColor = EV2Colors.Cyan
                    )
                ) {
                    Text(viewModel.reservationTime.value.toString())
                }
            }
        }
        
        // Guests & Duration
        item {
            SectionHeader("Party Details")
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StepperField(
                    label = "Guests",
                    value = viewModel.guestCount.value,
                    onValueChange = { viewModel.setGuestCount(it) },
                    modifier = Modifier.weight(1f),
                    min = 2,
                    max = 20
                )
                
                StepperField(
                    label = "Hours",
                    value = viewModel.durationHours.value,
                    onValueChange = { viewModel.setDurationHours(it) },
                    modifier = Modifier.weight(1f),
                    min = 1,
                    max = 6
                )
            }
        }
        
        // Available Tables
        item {
            SectionHeader("Select Table")
            Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                viewModel.availableTables.value.forEach { table ->
                    TableCard(
                        table = table,
                        isSelected = viewModel.selectedTable.value?.id == table.id,
                        onSelect = { viewModel.setSelectedTable(table) }
                    )
                }
            }
        }
        
        // Price Breakdown
        item {
            SectionHeader("Price Breakdown")
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF1a1a2e), shape = RoundedCornerShape(12.dp))
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                PriceRow("Base Price", "${String.format("%.2f", viewModel.totalPrice.value * 0.7)}")
                Divider(color = Color(0xFF333344), thickness = 1.dp)
                PriceRow(
                    "Deposit Required (30%)",
                    "$${String.format("%.2f", viewModel.depositAmount.value)}",
                    isTotal = true
                )
            }
        }
        
        // Special Requests
        item {
            SectionHeader("Special Requests")
            OutlinedTextField(
                value = specialRequests,
                onValueChange = { specialRequests = it },
                placeholder = { Text("Decorations, music preferences, etc.") },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(80.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EV2Colors.Cyan,
                    unfocusedBorderColor = Color(0xFF333344)
                )
            )
        }
        
        // Payment Method Selection
        item {
            SectionHeader("Payment Method")
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                PaymentMethod.values().forEach { method ->
                    PaymentMethodCard(
                        method = method,
                        isSelected = viewModel.selectedPaymentMethod.value == method,
                        onSelect = { viewModel.setPaymentMethod(method) }
                    )
                }
            }
        }
        
        // Reserve Button
        item {
            Button(
                onClick = {
                    viewModel.createReservation(
                        nightclubId = nightclubId,
                        specialRequests = specialRequests,
                        onSuccess = { reservation ->
                            createdReservation = reservation
                            showPaymentSheet = true
                            onReservationComplete(reservation)
                        },
                        onError = { error ->
                            // Show error
                        }
                    )
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = EV2Colors.Cyan
                ),
                enabled = viewModel.selectedTable.value != null && !viewModel.isProcessingPayment.value
            ) {
                if (viewModel.isProcessingPayment.value) {
                    CircularProgressIndicator(
                        color = Color.Black,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(20.dp)
                    )
                } else {
                    Text(
                        "Reserve & Pay",
                        fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                        color = Color.Black
                    )
                }
            }
        }
    }
    
    if (showPaymentSheet && createdReservation != null) {
        PaymentSheetModal(
            reservation = createdReservation!!,
            viewModel = viewModel,
            onDismiss = { showPaymentSheet = false }
        )
    }
}

// ==================== COMPOSABLE COMPONENTS ====================

@Composable
fun SectionHeader(text: String) {
    Text(
        text.uppercase(),
        fontSize = 10.sp,
        fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
        color = EV2Colors.Cyan,
        letterSpacing = 1.5.sp
    )
}

@Composable
fun TableCard(
    table: TableAvailability,
    isSelected: Boolean,
    onSelect: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = if (isSelected) Color(0xFF2a1a4a) else Color(0xFF1a1a2e),
                shape = RoundedCornerShape(12.dp)
            )
            .border(
                width = if (isSelected) 2.dp else 1.dp,
                color = if (isSelected) EV2Colors.Cyan else Color(0xFF333344),
                shape = RoundedCornerShape(12.dp)
            )
            .clickable(onClick = onSelect)
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    table.tableNumber,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    color = Color.White
                )
                Text(
                    table.section.uppercase(),
                    fontSize = 10.sp,
                    color = Color.Gray
                )
            }
            
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "Capacity: ${table.capacity}",
                    fontSize = 10.sp,
                    color = Color.Gray
                )
                if (isSelected) {
                    Icon(
                        Icons.Default.CheckCircle,
                        contentDescription = null,
                        tint = EV2Colors.Cyan,
                        modifier = Modifier.size(20.dp)
                    )
                }
            }
        }
    }
}

@Composable
fun StepperField(
    label: String,
    value: Int,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    min: Int = 1,
    max: Int = 10
) {
    Column(modifier = modifier) {
        Text(label, fontSize = 10.sp, color = Color.Gray)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF1a1a2e), shape = RoundedCornerShape(8.dp)),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(
                onClick = { if (value > min) onValueChange(value - 1) },
                modifier = Modifier.size(32.dp)
            ) {
                Icon(Icons.Default.Remove, contentDescription = null, tint = EV2Colors.Cyan)
            }
            
            Text(value.toString(), fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
            
            IconButton(
                onClick = { if (value < max) onValueChange(value + 1) },
                modifier = Modifier.size(32.dp)
            ) {
                Icon(Icons.Default.Add, contentDescription = null, tint = EV2Colors.Cyan)
            }
        }
    }
}

@Composable
fun PriceRow(label: String, amount: String, isTotal: Boolean = false) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, color = if (isTotal) Color.White else Color.Gray)
        Text(
            amount,
            fontWeight = if (isTotal) androidx.compose.ui.text.font.FontWeight.Bold else androidx.compose.ui.text.font.FontWeight.Normal,
            color = if (isTotal) EV2Colors.Cyan else Color.White
        )
    }
}

@Composable
fun PaymentMethodCard(
    method: PaymentMethod,
    isSelected: Boolean,
    onSelect: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = if (isSelected) Color(0xFF2a1a4a) else Color(0xFF1a1a2e),
                shape = RoundedCornerShape(12.dp)
            )
            .border(
                width = if (isSelected) 2.dp else 1.dp,
                color = if (isSelected) EV2Colors.Cyan else Color(0xFF333344),
                shape = RoundedCornerShape(12.dp)
            )
            .clickable(onClick = onSelect)
            .padding(16.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(
                Icons.Default.Payment,
                contentDescription = null,
                tint = EV2Colors.Cyan,
                modifier = Modifier.size(24.dp)
            )
            Text(method.displayName, color = Color.White)
            
            if (isSelected) {
                Spacer(modifier = Modifier.weight(1f))
                Icon(
                    Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint = EV2Colors.Cyan
                )
            }
        }
    }
}

@Composable
fun PaymentSheetModal(
    reservation: Reservation,
    viewModel: ReservationViewModel,
    onDismiss: () -> Unit
) {
    // Modal implementation for payment confirmation
}

#Preview
@Composable
fun ReservationScreenPreview() {
    ReservationSelectionScreen(
        nightclubId = "test-123",
        onReservationComplete = {}
    )
}
