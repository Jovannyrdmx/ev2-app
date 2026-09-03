// Android Kotlin - EV2 Clandestinoz Branded App

package com.ev2clandestinoz.easyflirt.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// EV2 Color Palette
object EV2Colors {
    val Cyan = Color(0xFF00BFFF)        // EV2 Cyan
    val Pink = Color(0xFFFF1493)        // EV2 Pink
    val Purple = Color(0xFF9D00FF)      // EV2 Purple
    val Lime = Color(0xFF00FF00)        // EV2 Lime
    val Gold = Color(0xFFFFD700)        // EV2 Gold
    val DarkBg = Color(0xFF0a0a14)      // Dark background
    val DarkBg2 = Color(0xFF1a0033)     // Dark variant
}

private val DarkColorScheme = darkColorScheme(
    primary = EV2Colors.Cyan,
    secondary = EV2Colors.Pink,
    tertiary = EV2Colors.Purple,
    background = EV2Colors.DarkBg,
    surface = Color(0xFF1a1a2e),
    onPrimary = Color.Black,
    onSecondary = Color.White,
    onTertiary = Color.White,
)

@Composable
fun EV2ClandestinozTheme(
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}

// ============ EV2 Composables ============

package com.ev2clandestinoz.easyflirt.ui.screens

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowRightCircle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ev2clandestinoz.easyflirt.ui.theme.EV2Colors

// EV2 Loading Screen
@Composable
fun EV2LoadingScreen(onComplete: () -> Unit) {
    var isVisible by remember { mutableStateOf(true) }
    
    if (!isVisible) {
        onComplete()
        return
    }
    
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                brush = Brush.linearGradient(
                    colors = listOf(
                        EV2Colors.DarkBg,
                        Color(0xFF1a0033),
                        Color(0xFF001a33)
                    )
                )
            )
            .clickable { isVisible = false },
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.fillMaxSize()
        ) {
            // EV2 Logo with glow
            Box(
                modifier = Modifier
                    .size(200.dp),
                contentAlignment = Alignment.Center
            ) {
                // Glow effect
                Box(
                    modifier = Modifier
                        .size(200.dp)
                        .background(
                            brush = Brush.radialGradient(
                                colors = listOf(
                                    EV2Colors.Cyan.copy(alpha = 0.2f),
                                    Color.Transparent
                                )
                            ),
                            shape = RoundedCornerShape(16.dp)
                        )
                        .blur(30.dp)
                )
                
                // Logo card
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .size(160.dp)
                        .background(
                            color = Color.Black.copy(alpha = 0.4f),
                            shape = RoundedCornerShape(20.dp)
                        )
                        .border(
                            width = 3.dp,
                            color = EV2Colors.Cyan,
                            shape = RoundedCornerShape(20.dp)
                        )
                        .padding(16.dp),
                    verticalArrangement = Arrangement.Center
                ) {
                    Text(
                        "EV2",
                        fontSize = 48.sp,
                        fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                        brush = Brush.linearGradient(
                            colors = listOf(
                                EV2Colors.Cyan,
                                EV2Colors.Pink,
                                EV2Colors.Purple,
                                EV2Colors.Lime,
                                EV2Colors.Gold
                            )
                        )
                    )
                    
                    Text(
                        "CLANDESTINOZ",
                        fontSize = 8.sp,
                        fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                        color = EV2Colors.Cyan,
                        letterSpacing = 2.sp
                    )
                }
            }
            
            Spacer(modifier = Modifier.height(24.dp))
            
            // Loading text
            Column(
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    "EASY FLIRT",
                    fontSize = 24.sp,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    brush = Brush.linearGradient(
                        colors = listOf(
                            EV2Colors.Cyan,
                            EV2Colors.Pink,
                            EV2Colors.Purple
                        )
                    )
                )
                
                Text(
                    "The hottest nightclub in Nogales",
                    fontSize = 12.sp,
                    color = EV2Colors.Cyan
                )
            }
            
            Spacer(modifier = Modifier.height(24.dp))
            
            // Animated dots
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                listOf(EV2Colors.Cyan, EV2Colors.Pink, EV2Colors.Purple).forEachIndexed { index, color ->
                    val infiniteTransition = rememberInfiniteTransition()
                    val scale by infiniteTransition.animateFloat(
                        initialValue = 1f,
                        targetValue = 1.2f,
                        animationSpec = infiniteRepeatable(
                            animation = tween(600),
                            repeatMode = RepeatMode.Reverse,
                            initialDelayMillis = index * 150
                        )
                    )
                    
                    Box(
                        modifier = Modifier
                            .size((8 * scale).dp)
                            .background(color = color, shape = RoundedCornerShape(50))
                    )
                }
            }
            
            Spacer(modifier = Modifier.height(16.dp))
            
            Text(
                "STEPPING INTO THE CLUB...",
                fontSize = 9.sp,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                color = EV2Colors.Cyan.copy(alpha = 0.6f),
                letterSpacing = 2.sp,
                textAlign = TextAlign.Center
            )
        }
    }
}

// EV2 Login Screen
@Composable
fun EV2LoginScreen(onLoginSuccess: () -> Unit) {
    var email by remember { mutableStateOf("guest@ev2clandestinoz.com") }
    var name by remember { mutableStateOf("Guest") }
    var isLoading by remember { mutableStateOf(false) }
    
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                brush = Brush.linearGradient(
                    colors = listOf(
                        EV2Colors.DarkBg,
                        Color(0xFF1a0033)
                    )
                )
            )
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(modifier = Modifier.height(20.dp))
            
            // Logo Section
            Column(
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Box(
                    modifier = Modifier
                        .size(140.dp)
                        .background(
                            color = Color.Black.copy(alpha = 0.3f),
                            shape = RoundedCornerShape(16.dp)
                        )
                        .border(
                            width = 2.dp,
                            color = EV2Colors.Cyan,
                            shape = RoundedCornerShape(16.dp)
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Text(
                            "EV2",
                            fontSize = 40.sp,
                            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                            brush = Brush.linearGradient(
                                colors = listOf(
                                    EV2Colors.Cyan,
                                    EV2Colors.Pink,
                                    EV2Colors.Purple
                                )
                            )
                        )
                        
                        Text(
                            "CLANDESTINOZ",
                            fontSize = 8.sp,
                            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                            color = EV2Colors.Cyan,
                            letterSpacing = 1.5.sp
                        )
                    }
                }
                
                Spacer(modifier = Modifier.height(16.dp))
                
                Text(
                    "Welcome to EV2",
                    fontSize = 20.sp,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                    brush = Brush.linearGradient(
                        colors = listOf(EV2Colors.Cyan, EV2Colors.Pink)
                    )
                )
                
                Text(
                    "The hottest nightclub in Nogales",
                    fontSize = 12.sp,
                    color = EV2Colors.Cyan
                )
            }
            
            Spacer(modifier = Modifier.height(32.dp))
            
            // Login Form
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email", color = EV2Colors.Cyan) },
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EV2Colors.Cyan,
                    unfocusedBorderColor = EV2Colors.Cyan.copy(alpha = 0.3f),
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White
                )
            )
            
            Spacer(modifier = Modifier.height(12.dp))
            
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Your name", color = EV2Colors.Cyan) },
                modifier = Modifier.fillMaxWidth(),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EV2Colors.Cyan,
                    unfocusedBorderColor = EV2Colors.Cyan.copy(alpha = 0.3f),
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White
                )
            )
            
            Spacer(modifier = Modifier.height(16.dp))
            
            // Enter Club Button
            Button(
                onClick = {
                    isLoading = true
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        onLoginSuccess()
                    }, 1000)
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = EV2Colors.Cyan
                ),
                enabled = !isLoading
            ) {
                Icon(
                    imageVector = Icons.Default.ArrowRightCircle,
                    contentDescription = null,
                    tint = Color.Black,
                    modifier = Modifier.size(20.dp)
                )
                
                Spacer(modifier = Modifier.width(8.dp))
                
                Text(
                    if (isLoading) "Entering..." else "Enter the Club",
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                    color = Color.Black
                )
            }
            
            Spacer(modifier = Modifier.height(16.dp))
            
            // Instagram Login
            Button(
                onClick = { /* Instagram login */ },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = EV2Colors.Pink
                ),
                enabled = !isLoading
            ) {
                Text(
                    "Continue with Instagram",
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold
                )
            }
            
            Spacer(modifier = Modifier.height(24.dp))
            
            // Footer
            Text(
                "18+ only • EV2 Clandestinoz",
                fontSize = 10.sp,
                color = EV2Colors.Cyan.copy(alpha = 0.7f),
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold
            )
            
            Text(
                "By entering, you agree to our Terms",
                fontSize = 9.sp,
                color = EV2Colors.Cyan.copy(alpha = 0.5f)
            )
        }
    }
}
